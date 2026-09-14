import * as T from 'three';
import type {DesignDocument,DesignNode} from './schema';
import {resolveColor} from './render';

const maps=[['textureAssetId','map',true],['normalTextureAssetId','normalMap',false],['roughnessTextureAssetId','roughnessMap',false],['metalnessTextureAssetId','metalnessMap',false],['emissiveTextureAssetId','emissiveMap',true],['aoTextureAssetId','aoMap',false]] as const;
/** Apply only supplied overrides so an imported model keeps its authored appearance. */
export async function applySceneMaterial(material:T.MeshStandardMaterial,node:DesignNode,doc:DesignDocument,imported=false){
  const config=node.scene?.material;if(!config)return;
  if(config.color!==undefined)material.color.set(resolveColor(config.color,doc.theme));
  for(const key of ['metalness','roughness','wireframe','emissiveIntensity','alphaTest','transparent'] as const)if(config[key]!==undefined)(material as any)[key]=config[key];
  if(config.emissive!==undefined)material.emissive.set(resolveColor(config.emissive,doc.theme));
  if(config.normalScale)material.normalScale.fromArray(config.normalScale);
  if(config.aoIntensity!==undefined)material.aoMapIntensity=config.aoIntensity;
  if(config.doubleSided!==undefined)material.side=config.doubleSided?T.DoubleSide:T.FrontSide;
  if(node.opacity!==undefined){material.opacity=node.opacity;if(config.transparent===undefined&&node.opacity<1)material.transparent=true;}
  for(const [key,map,color] of maps){
    const asset=doc.assets.find(a=>a.id===config[key]);if(!asset)continue;
    const texture=await new T.TextureLoader().loadAsync(asset.url);
    texture.flipY=config.textureFlipY??!imported;if(color)texture.colorSpace=T.SRGBColorSpace;
    const settings=config.textureSettings?.[key];if(settings){texture.offset.fromArray(settings.offset);texture.repeat.fromArray(settings.repeat);texture.center.fromArray(settings.center);texture.rotation=settings.rotation;texture.wrapS=settings.wrapS;texture.wrapT=settings.wrapT;}
    material[map]?.dispose();material[map]=texture;
  }
  material.needsUpdate=true;
}
