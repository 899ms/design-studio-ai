import * as T from 'three';
import {EffectComposer} from 'three/addons/postprocessing/EffectComposer.js';
import {RenderPass} from 'three/addons/postprocessing/RenderPass.js';
import {UnrealBloomPass} from 'three/addons/postprocessing/UnrealBloomPass.js';
import {OutputPass} from 'three/addons/postprocessing/OutputPass.js';
import {ShaderPass} from 'three/addons/postprocessing/ShaderPass.js';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
import type {DesignPage} from './schema';

type Emitter=NonNullable<NonNullable<DesignPage['scene']>['emitters']>[number];
const particles=new WeakMap<T.Scene,{object:T.Points;config:Emitter;offsets:Float32Array}[]>();
export function addSceneEffects(scene:T.Scene,page:DesignPage){
  const config=page.scene;
  if(config?.atmosphere)scene.fog=new T.FogExp2(config.atmosphere.fogColor,config.atmosphere.fogDensity);
  for(const item of config?.lights??[]){
    const light=item.type==='point'?new T.PointLight(item.color,item.intensity,item.distance??0):item.type==='spot'?new T.SpotLight(item.color,item.intensity,item.distance??0,item.angle??.6,.4):new T.DirectionalLight(item.color,item.intensity);
    light.position.fromArray(item.position);light.castShadow=item.shadow??false;light.name=`light-${item.id}`;
    if('target' in light){light.target.position.fromArray(item.target??[0,0,0]);scene.add(light.target);}
    scene.add(light);
  }
  const entries=[];
  for(const emitter of config?.emitters??[]){
    let seed=emitter.seed>>>0;const random=()=>{seed=(Math.imul(1664525,seed)+1013904223)>>>0;return seed/4294967296;};
    const offsets=new Float32Array(emitter.count*4);for(let i=0;i<offsets.length;i++)offsets[i]=random();
    const geometry=new T.BufferGeometry();geometry.setAttribute('position',new T.BufferAttribute(new Float32Array(emitter.count*3),3));
    const object=new T.Points(geometry,new T.PointsMaterial({color:emitter.color,size:emitter.size,transparent:true,opacity:.8,depthWrite:false,blending:T.AdditiveBlending}));
    object.name=`emitter-${emitter.id}`;object.userData.compositionBackground=true;object.frustumCulled=false;scene.add(object);entries.push({object,config:emitter,offsets});
  }
  particles.set(scene,entries);animateSceneEffects(scene,0);
}
export function animateSceneEffects(scene:T.Scene,time:number){
  for(const {object,config,offsets} of particles.get(scene)??[]){
    object.visible=time>=(config.start??0)&&time<=(config.end??3600);
    const position=object.geometry.getAttribute('position');
    for(let i=0;i<config.count;i++){const age=((time-(config.start??0))+offsets[i*4+3]*config.lifetime)%config.lifetime;
      for(let axis=0;axis<3;axis++)position.array[i*3+axis]=config.position[axis]+(offsets[i*4+axis]-.5)*config.spread[axis]+config.velocity[axis]*age;
    }position.needsUpdate=true;
  }
}
/** Editor, published viewer and raster exports share this rendering configuration. */
export function createSceneRenderer(renderer:T.WebGLRenderer,scene:T.Scene,camera:T.Camera,page:DesignPage){
  const config=page.scene?.rendering;
  renderer.shadowMap.enabled=config?.shadows??true;renderer.shadowMap.type=T.PCFSoftShadowMap;
  renderer.toneMapping=config?T.ACESFilmicToneMapping:T.NoToneMapping;renderer.toneMappingExposure=config?.exposure??1;
  let environment:T.WebGLRenderTarget|undefined;
  if(config?.environmentIntensity){const generator=new T.PMREMGenerator(renderer),room=new RoomEnvironment();environment=generator.fromScene(room);scene.environment=environment.texture;scene.environmentIntensity=config.environmentIntensity;room.dispose();generator.dispose();}
  let composer:EffectComposer|undefined,lastWidth=0,lastHeight=0;
  let base:T.WebGLRenderTarget|undefined;
  if(config?.bloom){
    base=new T.WebGLRenderTarget(1,1,{type:T.HalfFloatType});
    composer=new EffectComposer(renderer);composer.addPass(new RenderPass(scene,camera));composer.addPass(new UnrealBloomPass(new T.Vector2(1,1),config.bloom,.5,config.bloomThreshold??1));
    // Bloom's intermediate passes are opaque. Restore layer transparency while
    // retaining the glow, so a later 3D segment cannot black out earlier 2D art.
    const alphaPass=new ShaderPass({uniforms:{tDiffuse:{value:null},base:{value:null}},vertexShader:'varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',fragmentShader:'uniform sampler2D tDiffuse; uniform sampler2D base; varying vec2 vUv; void main(){vec4 original=texture2D(base,vUv);vec3 combined=texture2D(tDiffuse,vUv).rgb;vec3 glow=max(combined-original.rgb,vec3(0.0));float alpha=max(original.a,clamp(max(glow.r,max(glow.g,glow.b)),0.0,1.0));gl_FragColor=vec4(combined/max(alpha,0.0001),alpha);}'});
    // ShaderPass clones uniform definitions and drops render-target textures.
    alphaPass.uniforms.base.value=base.texture;composer.addPass(alphaPass);
    composer.addPass(new OutputPass());
  }
  return {draw:()=>{
    if(composer&&base){const size=renderer.getSize(new T.Vector2());if(size.x!==lastWidth||size.y!==lastHeight){lastWidth=size.x;lastHeight=size.y;composer.setPixelRatio(renderer.getPixelRatio());composer.setSize(size.x,size.y);const pixels=renderer.getDrawingBufferSize(new T.Vector2());base.setSize(pixels.x,pixels.y);}
      const target=renderer.getRenderTarget();renderer.setRenderTarget(base);renderer.clear();renderer.render(scene,camera);renderer.setRenderTarget(target);composer.render(0);
    }else renderer.render(scene,camera);
  },dispose:()=>{for(const pass of composer?.passes??[])pass.dispose();composer?.dispose();base?.dispose();if(environment){scene.environment=null;environment.dispose();}}};
}
