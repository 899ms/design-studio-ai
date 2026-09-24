import * as T from 'three';
import {EffectComposer} from 'three/addons/postprocessing/EffectComposer.js';
import {UnrealBloomPass} from 'three/addons/postprocessing/UnrealBloomPass.js';
import {OutputPass} from 'three/addons/postprocessing/OutputPass.js';
import {ShaderPass} from 'three/addons/postprocessing/ShaderPass.js';
import {FullScreenQuad} from 'three/addons/postprocessing/Pass.js';
import {CopyShader} from 'three/addons/shaders/CopyShader.js';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
import {Sky} from 'three/addons/objects/Sky.js';
import type {DesignPage} from './schema';

type Settings=NonNullable<DesignPage['scene']>;
type Emitter=NonNullable<Settings['emitters']>[number];
type Particles={object:T.Points;config:Emitter;offsets:Float32Array;extra:Float32Array};
const particles=new WeakMap<T.Scene,Particles[]>();
const sprites=new Map<string,T.DataTexture>();

/** Procedural sprites keep particles renderable in workers and headless exports without a DOM canvas. */
function spriteTexture(kind:'soft'|'flake'|'mist'){
  let texture=sprites.get(kind);if(texture)return texture;
  const size=64,data=new Uint8Array(size*size*4);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const u=(x+.5)/size*2-1,v=(y+.5)/size*2-1,r=Math.hypot(u,v),angle=Math.atan2(v,u);let alpha:number;
    if(kind==='soft')alpha=Math.exp(-r*r*4.5)*(r<1?1:0);
    else if(kind==='mist')alpha=Math.max(0,1-r)**2*(.8+.2*Math.sin(u*7.1+Math.cos(v*5.3)*2)*Math.cos(v*6.7));
    else{const arm=Math.abs(Math.cos(angle*3)),spoke=Math.exp(-(((1-arm)*r*14)**2))*(r<.95?1:0);alpha=Math.max(spoke*(1-r*.6),Math.exp(-r*r*30));}
    const i=(y*size+x)*4;data[i]=data[i+1]=data[i+2]=255;data[i+3]=Math.round(Math.min(1,Math.max(0,alpha))*255);
  }
  texture=new T.DataTexture(data,size,size);texture.needsUpdate=true;texture.magFilter=T.LinearFilter;texture.minFilter=T.LinearFilter;sprites.set(kind,texture);return texture;
}
const shaded=(emitter:Emitter)=>!!emitter.sprite&&emitter.sprite!=='square'||emitter.fadeIn!==undefined||emitter.fadeOut!==undefined||emitter.sizeVariance!==undefined;
function particleMaterial(emitter:Emitter){
  const blending=emitter.blending==='normal'?T.NormalBlending:T.AdditiveBlending,opacity=emitter.opacity??.8;
  // Unshaded emitters keep the original PointsMaterial so earlier documents render unchanged.
  if(!shaded(emitter))return new T.PointsMaterial({color:emitter.color,size:emitter.size,transparent:true,opacity,depthWrite:false,blending});
  const sprite=emitter.sprite&&emitter.sprite!=='square'?emitter.sprite:'soft';
  const material=new T.ShaderMaterial({
    uniforms:T.UniformsUtils.merge([T.UniformsLib.fog,{diffuse:{value:new T.Color(emitter.color)},opacity:{value:opacity},size:{value:emitter.size},scale:{value:1}}]),
    vertexShader:'attribute float alpha;attribute float sizeFactor;uniform float size;uniform float scale;varying float vAlpha;\n#include <common>\n#include <fog_pars_vertex>\nvoid main(){vAlpha=alpha;vec4 mvPosition=modelViewMatrix*vec4(position,1.0);gl_PointSize=size*sizeFactor*(scale/-mvPosition.z);gl_Position=projectionMatrix*mvPosition;\n#include <fog_vertex>\n}',
    fragmentShader:'uniform vec3 diffuse;uniform float opacity;uniform sampler2D map;varying float vAlpha;\n#include <common>\n#include <fog_pars_fragment>\nvoid main(){float a=texture2D(map,gl_PointCoord).a*opacity*vAlpha;if(a<0.002)discard;gl_FragColor=vec4(diffuse,a);\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n#include <fog_fragment>\n}',
    transparent:true,depthWrite:false,blending,fog:true,
  });
  material.uniforms.map={value:spriteTexture(sprite)};return material;
}
// Runtime state stays out of userData, which GLTFExporter serializes into every GLB.
const sceneTimes=new WeakMap<T.Scene,number>();
/** Loaded equirectangular panorama for a scene, consumed by the renderer's environment. */
export const scenePanoramas=new WeakMap<T.Scene,T.Texture>();
export function addSceneEffects(scene:T.Scene,page:DesignPage){
  const config=page.scene;
  if(config?.atmosphere)scene.fog=new T.FogExp2(config.atmosphere.fogColor,config.atmosphere.fogDensity);
  for(const item of config?.lights??[]){
    const light=item.type==='point'?new T.PointLight(item.color,item.intensity,item.distance??0):item.type==='spot'?new T.SpotLight(item.color,item.intensity,item.distance??0,item.angle??.6,.4):new T.DirectionalLight(item.color,item.intensity);
    light.position.fromArray(item.position);light.castShadow=item.shadow??false;light.name=`light-${item.id}`;
    if('target' in light){light.target.position.fromArray(item.target??[0,0,0]);scene.add(light.target);}
    scene.add(light);
  }
  const entries:Particles[]=[];
  for(const emitter of config?.emitters??[]){
    let seed=emitter.seed>>>0;const random=()=>{seed=(Math.imul(1664525,seed)+1013904223)>>>0;return seed/4294967296;};
    const offsets=new Float32Array(emitter.count*4);for(let i=0;i<offsets.length;i++)offsets[i]=random();
    // A separate stream keeps the original four values per particle, and so legacy positions, stable.
    seed=(emitter.seed^0x9e3779b9)>>>0;const extra=new Float32Array(emitter.count*7);for(let i=0;i<extra.length;i++)extra[i]=random();
    const geometry=new T.BufferGeometry();geometry.setAttribute('position',new T.BufferAttribute(new Float32Array(emitter.count*3),3));
    const material=particleMaterial(emitter);
    if(material instanceof T.ShaderMaterial){
      geometry.setAttribute('alpha',new T.BufferAttribute(new Float32Array(emitter.count).fill(1),1));
      geometry.setAttribute('sizeFactor',new T.BufferAttribute(Float32Array.from({length:emitter.count},(_,i)=>1-(emitter.sizeVariance??0)*extra[i*7+6]),1));
    }
    const object=new T.Points(geometry,material);
    if(material instanceof T.ShaderMaterial){const size=new T.Vector2();object.onBeforeRender=renderer=>{material.uniforms.scale.value=renderer.getDrawingBufferSize(size).y/2;};}
    object.name=`emitter-${emitter.id}`;object.userData.compositionBackground=true;object.frustumCulled=false;scene.add(object);entries.push({object,config:emitter,offsets,extra});
  }
  particles.set(scene,entries);animateSceneEffects(scene,0);
}
const p=[0,0,0];
export function animateSceneEffects(scene:T.Scene,time:number){
  sceneTimes.set(scene,time);
  for(const {object,config,offsets,extra} of particles.get(scene)??[]){
    object.visible=time>=(config.start??0)&&time<=(config.end??3600);
    const position=object.geometry.getAttribute('position'),alpha=object.geometry.getAttribute('alpha');
    const gravity=config.gravity??[0,0,0],turbulence=config.turbulence??0,swirl=config.swirl??0,fadeIn=(config.fadeIn??0)*config.lifetime,fadeOut=(config.fadeOut??0)*config.lifetime;
    for(let i=0;i<config.count;i++){const age=((time-(config.start??0))+offsets[i*4+3]*config.lifetime)%config.lifetime;
      for(let axis=0;axis<3;axis++)p[axis]=config.position[axis]+(offsets[i*4+axis]-.5)*config.spread[axis]+config.velocity[axis]*age+.5*gravity[axis]*age*age+(turbulence?turbulence*Math.sin(age*(.6+extra[i*7+axis]*1.8)+extra[i*7+3+axis]*Math.PI*2):0);
      if(swirl){const angle=swirl*age,dx=p[0]-config.position[0],dz=p[2]-config.position[2];p[0]=config.position[0]+dx*Math.cos(angle)-dz*Math.sin(angle);p[2]=config.position[2]+dx*Math.sin(angle)+dz*Math.cos(angle);}
      for(let axis=0;axis<3;axis++)position.array[i*3+axis]=p[axis];
      if(alpha)alpha.array[i]=Math.max(0,Math.min(1,fadeIn>0?age/fadeIn:1,fadeOut>0?(config.lifetime-age)/fadeOut:1));
    }position.needsUpdate=true;if(alpha)alpha.needsUpdate=true;
  }
}
const quadVertex='varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}';
/** Combines depth of field, bloom glow and light shafts, restoring layer transparency so a later 3D segment cannot black out earlier 2D art. */
const compositeShader={
  uniforms:{tDiffuse:{value:null},base:{value:null},depthMap:{value:null},bloomMap:{value:null},bloomSource:{value:null},hasBloom:{value:false},hasDof:{value:false},focus:{value:10},aperture:{value:0},maxBlur:{value:0},near:{value:.01},far:{value:10000},aspect:{value:1},hasShafts:{value:false},lightUv:{value:new T.Vector2()},shaftIntensity:{value:0},shaftDecay:{value:.96},shaftThreshold:{value:.6}},
  vertexShader:quadVertex,
  fragmentShader:`#include <packing>
uniform sampler2D base;uniform sampler2D depthMap;uniform sampler2D bloomMap;uniform sampler2D bloomSource;uniform bool hasBloom;uniform bool hasDof;uniform float focus;uniform float aperture;uniform float maxBlur;uniform float near;uniform float far;uniform float aspect;uniform bool hasShafts;uniform vec2 lightUv;uniform float shaftIntensity;uniform float shaftDecay;uniform float shaftThreshold;varying vec2 vUv;
void main(){
  vec4 color=texture2D(base,vUv);
  if(hasDof){float distance=-perspectiveDepthToViewZ(texture2D(depthMap,vUv).x,near,far);float blur=clamp(abs(distance-focus)/max(distance,0.001)*aperture,0.0,maxBlur);
    if(blur>0.0001){vec4 sum=color;for(int i=0;i<24;i++){float radius=sqrt((float(i)+0.5)/24.0),theta=float(i)*2.39996;sum+=texture2D(base,vUv+vec2(cos(theta)/aspect,sin(theta))*radius*blur);}color=sum/25.0;}}
  vec3 glow=vec3(0.0);
  if(hasBloom)glow=max(texture2D(bloomMap,vUv).rgb-texture2D(bloomSource,vUv).rgb,vec3(0.0));
  if(hasShafts){vec2 step=(vUv-lightUv)/48.0,uv=vUv;float weight=1.0;vec3 sum=vec3(0.0);for(int i=0;i<48;i++){uv-=step;sum+=max(texture2D(base,uv).rgb-vec3(shaftThreshold),vec3(0.0))*weight;weight*=shaftDecay;}glow+=sum/48.0*shaftIntensity;}
  float alpha=max(color.a,clamp(max(glow.r,max(glow.g,glow.b)),0.0,1.0));
  gl_FragColor=vec4((color.rgb+glow)/max(alpha,0.0001),alpha);
}`,
};
/** Display-space grading, vignette and seeded grain after tone mapping. */
const lookShader={
  uniforms:{tDiffuse:{value:null},contrast:{value:1},saturation:{value:1},tint:{value:new T.Color(1,1,1)},tintStrength:{value:0},vignette:{value:0},grain:{value:0},time:{value:0},resolution:{value:new T.Vector2(1,1)}},
  vertexShader:quadVertex,
  fragmentShader:`uniform sampler2D tDiffuse;uniform float contrast;uniform float saturation;uniform vec3 tint;uniform float tintStrength;uniform float vignette;uniform float grain;uniform float time;uniform vec2 resolution;varying vec2 vUv;
void main(){
  vec4 color=texture2D(tDiffuse,vUv);vec3 rgb=color.rgb;const vec3 weights=vec3(0.2126,0.7152,0.0722);
  rgb=mix(vec3(dot(rgb,weights)),rgb,saturation);rgb=(rgb-0.5)*contrast+0.5;
  rgb=mix(rgb,rgb*tint/max(dot(tint,weights),0.001),tintStrength);
  rgb*=1.0-vignette*smoothstep(0.35,0.95,length(vUv-0.5)*1.4142);
  rgb+=(fract(sin(dot(floor(vUv*resolution)+floor(time*24.0)*vec2(17.0,31.0),vec2(12.9898,78.233)))*43758.5453)-0.5)*grain*0.15;
  gl_FragColor=vec4(clamp(rgb,0.0,1.0),color.a);
}`,
};
/** True when the renderer must output straight alpha from the post-processing chain. */
export function sceneUsesPostProcessing(page:DesignPage){const r=page.scene?.rendering;return !!(r&&(r.bloom||r.vignette||r.grain||r.grading||r.depthOfField||r.lightShafts));}
function createEnvironment(renderer:T.WebGLRenderer,scene:T.Scene,rendering:NonNullable<Settings['rendering']>){
  const mode=rendering.environment??(rendering.environmentIntensity?'room':undefined),intensity=rendering.environmentIntensity??(rendering.environment?1:0),owned:{dispose():void}[]=[];
  if(!mode)return owned;
  const generator=new T.PMREMGenerator(renderer);let target:T.WebGLRenderTarget|undefined,background:T.Object3D|undefined;
  try{
    if(mode==='sky'){
      const sky=new Sky(),settings=rendering.sky??{elevation:12,azimuth:180},uniforms=sky.material.uniforms;
      uniforms.turbidity.value=settings.turbidity??8;uniforms.rayleigh.value=settings.rayleigh??1.5;uniforms.sunPosition.value.setFromSphericalCoords(1,T.MathUtils.degToRad(90-settings.elevation),T.MathUtils.degToRad(settings.azimuth));
      const probe=new T.Scene();sky.scale.setScalar(10);probe.add(sky);target=generator.fromScene(probe,0,.1,100);probe.remove(sky);
      if(rendering.environmentBackground){sky.scale.setScalar(4000);background=sky;}else{sky.geometry.dispose();sky.material.dispose();}
    }else if(mode==='panorama'&&scenePanoramas.has(scene)){
      const texture=scenePanoramas.get(scene)!;target=generator.fromEquirectangular(texture);
      if(rendering.environmentBackground){const geometry=new T.SphereGeometry(4000,64,32);geometry.scale(-1,1,1);background=new T.Mesh(geometry,new T.MeshBasicMaterial({map:texture,depthWrite:false,fog:false,toneMapped:false}));}
      else owned.push(texture);
    }else if(mode==='room'){const room=new RoomEnvironment();target=generator.fromScene(room);room.dispose();}
  }finally{generator.dispose();}
  if(target){scene.environment=target.texture;scene.environmentIntensity=intensity;const texture=target;owned.push({dispose:()=>{if(scene.environment===texture.texture)scene.environment=null;texture.dispose();}});}
  if(background){background.name='scene-environment-background';background.userData.compositionBackground=true;background.renderOrder=-1000;scene.add(background);const object=background;owned.push({dispose:()=>{scene.remove(object);object.traverse(child=>{if(child instanceof T.Mesh){child.geometry.dispose();for(const material of [child.material].flat()){(material as T.MeshBasicMaterial).map?.dispose();material.dispose();}}});}});}
  return owned;
}
/** Editor, published viewer and raster exports share this rendering configuration. */
export function createSceneRenderer(renderer:T.WebGLRenderer,scene:T.Scene,camera:T.Camera,page:DesignPage){
  const config=page.scene?.rendering;
  renderer.shadowMap.enabled=config?.shadows??true;renderer.shadowMap.type=T.PCFSoftShadowMap;
  renderer.toneMapping=config?T.ACESFilmicToneMapping:T.NoToneMapping;renderer.toneMappingExposure=config?.exposure??1;
  const owned=config?createEnvironment(renderer,scene,config):[];
  if(!config||!sceneUsesPostProcessing(page))return {draw:()=>renderer.render(scene,camera),dispose:()=>{for(const item of owned)item.dispose();}};
  const base=new T.WebGLRenderTarget(1,1,{type:T.HalfFloatType,depthTexture:new T.DepthTexture(1,1)});
  const bloomSource=new T.WebGLRenderTarget(1,1,{type:T.HalfFloatType}),bloomTarget=new T.WebGLRenderTarget(1,1,{type:T.HalfFloatType});
  const bloom=config.bloom?new UnrealBloomPass(new T.Vector2(1,1),config.bloom,.5,config.bloomThreshold??1):undefined;
  const copyMaterial=new T.ShaderMaterial({uniforms:T.UniformsUtils.clone(CopyShader.uniforms),vertexShader:CopyShader.vertexShader,fragmentShader:CopyShader.fragmentShader,blending:T.NoBlending,depthTest:false,depthWrite:false}),copy=new FullScreenQuad(copyMaterial);
  const black=new T.MeshBasicMaterial({color:0x000000});
  const composer=new EffectComposer(renderer),composite=new ShaderPass(compositeShader);composer.addPass(composite);composer.addPass(new OutputPass());
  // ShaderPass clones uniform definitions and drops render-target textures.
  const uniforms=composite.uniforms;uniforms.base.value=base.texture;uniforms.depthMap.value=base.depthTexture;uniforms.hasBloom.value=!!bloom;
  uniforms.bloomMap.value=bloomTarget.texture;uniforms.bloomSource.value=bloomSource.texture;
  if(config.depthOfField){uniforms.hasDof.value=true;uniforms.focus.value=config.depthOfField.focus;uniforms.aperture.value=config.depthOfField.aperture;uniforms.maxBlur.value=config.depthOfField.maxBlur;}
  if(config.lightShafts){uniforms.hasShafts.value=true;uniforms.shaftIntensity.value=config.lightShafts.intensity;uniforms.shaftDecay.value=config.lightShafts.decay??.96;uniforms.shaftThreshold.value=config.lightShafts.threshold??.6;}
  const graded=config.vignette||config.grain||config.grading,look=graded?new ShaderPass(lookShader):undefined;
  if(look){const u=look.uniforms;u.contrast.value=config.grading?.contrast??1;u.saturation.value=config.grading?.saturation??1;u.tint.value=new T.Color(config.grading?.tint??'#ffffff');u.tintStrength.value=config.grading?.tintStrength??0;u.vignette.value=config.vignette??0;u.grain.value=config.grain??0;composer.addPass(look);}
  let lastWidth=0,lastHeight=0;const light=new T.Vector3();
  return {draw:()=>{
    const size=renderer.getSize(new T.Vector2());
    if(size.x!==lastWidth||size.y!==lastHeight){lastWidth=size.x;lastHeight=size.y;composer.setPixelRatio(renderer.getPixelRatio());composer.setSize(size.x,size.y);const pixels=renderer.getDrawingBufferSize(new T.Vector2());for(const target of [base,bloomSource,bloomTarget])target.setSize(pixels.x,pixels.y);
      // Bloom kernels and grain cells are measured in pixels. A downscaled preview keeps them at full resolution so its glow and grain match the export relative to the frame.
      const effect=pixels.clone().divideScalar(Math.min(1,renderer.getPixelRatio())).round();bloom?.setSize(effect.x,effect.y);if(look)look.uniforms.resolution.value.copy(effect);}
    const target=renderer.getRenderTarget();renderer.setRenderTarget(base);renderer.clear();renderer.render(scene,camera);
    if(bloom){
      // Excluded nodes occlude the glow as black silhouettes instead of emitting it. HDR sky and panorama backgrounds would otherwise bloom the whole frame white.
      const excluded:T.Mesh[]=[];scene.traverseVisible(object=>{if(object instanceof T.Mesh&&(object.userData.bloom===false||object.userData.compositionBackground))excluded.push(object);});
      if(excluded.length){const materials=excluded.map(mesh=>mesh.material);excluded.forEach(mesh=>{mesh.material=black;});const background=scene.background;scene.background=null;renderer.setRenderTarget(bloomSource);renderer.clear();renderer.render(scene,camera);scene.background=background;excluded.forEach((mesh,i)=>{mesh.material=materials[i];});}
      else{copyMaterial.uniforms.tDiffuse.value=base.texture;renderer.setRenderTarget(bloomSource);copy.render(renderer);}
      copyMaterial.uniforms.tDiffuse.value=bloomSource.texture;renderer.setRenderTarget(bloomTarget);copy.render(renderer);
      bloom.render(renderer,bloomTarget,bloomTarget,0,false);
    }
    renderer.setRenderTarget(target);
    if(camera instanceof T.PerspectiveCamera){uniforms.near.value=camera.near;uniforms.far.value=camera.far;uniforms.aspect.value=camera.aspect;}
    if(config.lightShafts){light.fromArray(config.lightShafts.position).project(camera);uniforms.lightUv.value.set(light.x*.5+.5,light.y*.5+.5);/* Projection mirrors a source behind the camera, so its shafts would point the wrong way. */uniforms.shaftIntensity.value=light.z>1?0:config.lightShafts.intensity;}
    if(look)look.uniforms.time.value=sceneTimes.get(scene)??0;
    composer.render(0);
  },dispose:()=>{for(const pass of composer.passes)pass.dispose();composer.dispose();bloom?.dispose();copy.dispose();copyMaterial.dispose();black.dispose();base.depthTexture?.dispose();for(const item of [base,bloomSource,bloomTarget,...owned])item.dispose();}};
}
