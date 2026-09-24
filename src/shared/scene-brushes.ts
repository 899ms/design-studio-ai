import {Vector3} from 'three';
import type {MeshData} from './design-capabilities';
import {adjacency} from './scene-mesh-topology';
import {refreshMeshShading} from './mesh-shading';
export function paintWeights(mesh:MeshData,bone:number,center:number[],radius:number,strength:number,mode:'add'|'subtract'|'smooth',lockedBones:number[],lockedVertices:number[]){
 if(!mesh.skinIndices||!mesh.skinWeights)throw new Error('Bind this mesh before painting weights');
 if(lockedBones.includes(bone))throw new Error('Selected bone is locked');
 for(let i=0;i<mesh.skinWeights.length;i+=4)if(Math.abs(mesh.skinWeights.slice(i,i+4).reduce((a,b)=>a+b,0)-1)>.0001)throw new Error('Normalize skin weights before brushing');
 const ids=[...mesh.skinIndices],weights=[...mesh.skinWeights],links=adjacency(mesh),blocked=new Set(lockedVertices),locked=new Set(lockedBones),point=new Vector3().fromArray(center);
 for(let i=0;i<mesh.positions.length/3;i++){
  const distance=new Vector3().fromArray(mesh.positions,i*3).distanceTo(point);if(blocked.has(i)||distance>radius)continue;
  const current=new Map<number,number>();for(let j=0;j<4;j++)current.set(ids[i*4+j],(current.get(ids[i*4+j])??0)+weights[i*4+j]);
  const old=current.get(bone)??0,falloff=strength*(1-distance/radius)**2;
  let target=mode==='add'?Math.min(1,old+falloff):Math.max(0,old-falloff);
  if(mode==='smooth'){let sum=0;for(const v of links[i])for(let j=0;j<4;j++)if(ids[v*4+j]===bone)sum+=weights[v*4+j];target=old+(sum/Math.max(1,links[i].size)-old)*falloff;}
  const fixed=[...current].filter(([id,w])=>locked.has(id)&&w>0),reserved=fixed.reduce((s,[,w])=>s+w,0);
  if(fixed.length>=4)continue;target=Math.min(target,1-reserved);
  const others=[...current].filter(([id,w])=>id!==bone&&!locked.has(id)&&w>0).sort((a,b)=>b[1]-a[1]).slice(0,3-fixed.length);
  if(!others.length&&target<1-reserved)continue;
  const sum=others.reduce((s,[,w])=>s+w,0),values=[...fixed,[bone,target],...others.map(([id,w])=>[id,w/sum*(1-reserved-target)])];
  for(let j=0;j<4;j++){mesh.skinIndices[i*4+j]=values[j]?.[0]??0;mesh.skinWeights[i*4+j]=values[j]?.[1]??0;}
 }
}
export type SculptMode='smooth'|'inflate'|'move'|'crease'|'flatten'|'pinch';
/** Coincident vertices (UV or normal seams) share one id so brushes move both sides of a seam together. */
function weldedIds(positions:number[]){const ids=new Int32Array(positions.length/3),first=new Map<string,number>();for(let i=0;i<ids.length;i++){const key=[0,1,2].map(a=>Math.round(positions[i*3+a]*1e5)).join(',');ids[i]=first.get(key)??i;if(!first.has(key))first.set(key,i);}return ids;}
/** Apply simultaneous dabs against one snapshot so mirrored dabs that overlap stay symmetric. */
function dab(mesh:MeshData,weld:Int32Array,rings:Map<number,Set<number>>,brushes:{center:Vector3;delta:Vector3}[],radius:number,strength:number,mode:SculptMode){
 const positions=[...mesh.positions],count=positions.length/3,normals=new Map<number,Vector3>(),at=(i:number)=>new Vector3().fromArray(positions,i*3);
 // Angle-weighted normals do not depend on how flat regions happen to be triangulated.
 if(mode==='inflate'||mode==='crease'||mode==='flatten')for(let i=0;i<mesh.indices.length;i+=3){const ids=mesh.indices.slice(i,i+3),[p,q,r]=ids.map(at),normal=q.clone().sub(p).cross(r.clone().sub(p));if(normal.lengthSq()<1e-24)continue;normal.normalize();ids.forEach((v,k)=>{const o=[p,q,r][k],angle=[p,q,r][(k+1)%3].clone().sub(o).angleTo([p,q,r][(k+2)%3].clone().sub(o)),w=weld[v];normals.set(w,(normals.get(w)??new Vector3()).addScaledVector(normal,angle));});}
 const offsets=new Map<number,Vector3>();
 for(const {center,delta} of brushes){
  const inside:number[]=[];for(let i=0;i<count;i++)if(at(i).distanceTo(center)<=radius)inside.push(i);
  // Flatten projects onto the plane through the brushed area's centroid, facing its average normal.
  const plane=new Vector3(),planeNormal=new Vector3();if(mode==='flatten'){for(const i of inside){plane.add(at(i));planeNormal.add((normals.get(weld[i])?.clone()??new Vector3()).normalize());}plane.divideScalar(Math.max(1,inside.length));planeNormal.normalize();}
  for(const i of inside){const p=at(i),falloff=strength*(1-p.distanceTo(center)/radius)**2,normal=(normals.get(weld[i])?.clone()??new Vector3()).normalize();let change=delta.clone();
   if(mode==='inflate')change=normal.multiplyScalar(radius*.1);
   if(mode==='crease')change=normal.multiplyScalar(-radius*.1).add(center.clone().sub(p).multiplyScalar(.3));
   if(mode==='pinch')change=center.clone().sub(p).multiplyScalar(.5);
   if(mode==='flatten')change=planeNormal.clone().multiplyScalar(-p.clone().sub(plane).dot(planeNormal));
   if(mode==='smooth'){change=new Vector3();const ring=rings.get(weld[i])??new Set<number>();for(const j of ring)change.add(at(j));change.divideScalar(Math.max(1,ring.size)).sub(p);}
   offsets.set(i,(offsets.get(i)??new Vector3()).addScaledVector(change,falloff));
  }
 }
 let changed=false;
 for(const [i,offset] of offsets){const p=at(i).add(offset);if(p.x!==positions[i*3]||p.y!==positions[i*3+1]||p.z!==positions[i*3+2])changed=true;mesh.positions.splice(i*3,3,...p.toArray());}
 return changed;
}
/** Brush along the center and optional path; symmetry repeats each dab mirrored across x = 0 in mesh space. */
export function sculpt(mesh:MeshData,center:number[],radius:number,strength:number,mode:SculptMode,delta:number[],options:{path?:number[][];symmetry?:boolean}={}){
 const weld=weldedIds(mesh.positions),rings=new Map<number,Set<number>>(),stops=[center,...(options.path??[])].map(p=>new Vector3().fromArray(p)),dabs=[stops[0]];
 for(let s=1;s<stops.length;s++){const steps=Math.max(1,Math.ceil(stops[s-1].distanceTo(stops[s])/(radius*.35)));for(let k=1;k<=steps;k++)dabs.push(stops[s-1].clone().lerp(stops[s],k/steps));}
 adjacency(mesh).forEach((links,i)=>{const ring=rings.get(weld[i])??new Set<number>();for(const j of links)if(weld[j]!==weld[i])ring.add(weld[j]);rings.set(weld[i],ring);});
 if(dabs.length>400)throw new Error('Sculpt path is too long for the brush radius; split it or use a larger radius');
 let changed=false;const move=new Vector3().fromArray(delta),mirrored=new Vector3(-move.x,move.y,move.z);
 for(const point of dabs)changed=dab(mesh,weld,rings,[{center:point,delta:move},...(options.symmetry&&Math.abs(point.x)>1e-9?[{center:new Vector3(-point.x,point.y,point.z),delta:mirrored}]:[])],radius,strength,mode)||changed;
 if(changed)refreshMeshShading(mesh);
}/** Split each requested edge in every incident face, retaining all interpolated vertex data. */
export function splitEdges(mesh:MeshData,edges:[number,number][],fractions:number[]=[]){
 for(const [edgeIndex,[a,b]] of edges.entries()){const t=fractions[edgeIndex]??.5;if(a===b||a>=mesh.positions.length/3||b>=mesh.positions.length/3)throw new Error('Unknown edge');
  if(!mesh.indices.some((v,i)=>i%3===0&&mesh.indices.slice(i,i+3).includes(a)&&mesh.indices.slice(i,i+3).includes(b)))throw new Error('Selected vertices do not form an edge');
  if(mesh.positions.length>=899997||mesh.indices.length+6>1800000)throw new Error('Mesh refinement budget reached');
  const m=mesh.positions.length/3;
  for(const [buffer,width] of [[mesh.positions,3],[mesh.uv,2],[mesh.colors,3],...(mesh.morphTargets??[]).map(t=>[t.positions,3])] as [number[]|undefined,number][]){if(buffer)for(let j=0;j<width;j++)buffer.push(buffer[a*width+j]*(1-t)+buffer[b*width+j]*t);}
  if(mesh.normals){const normal=new Vector3().fromArray(mesh.normals,a*3).lerp(new Vector3().fromArray(mesh.normals,b*3),t).normalize();mesh.normals.push(...normal.toArray());}
  if(mesh.skinIndices&&mesh.skinWeights){const values=new Map<number,number>();for(const v of [a,b])for(let j=0;j<4;j++)values.set(mesh.skinIndices[v*4+j],(values.get(mesh.skinIndices[v*4+j])??0)+mesh.skinWeights[v*4+j]*(v===a?1-t:t));const top=[...values].sort((a,b)=>b[1]-a[1]).slice(0,4),sum=top.reduce((s,[,w])=>s+w,0);if(sum<=0)throw new Error('Normalize skin weights before refining');for(let j=0;j<4;j++){mesh.skinIndices.push(top[j]?.[0]??0);mesh.skinWeights.push((top[j]?.[1]??0)/sum);}}
  const triangles:number[]=[];for(let i=0;i<mesh.indices.length;i+=3){const ids=mesh.indices.slice(i,i+3);let split=false;for(let j=0;j<3;j++){const x=ids[j],y=ids[(j+1)%3],z=ids[(j+2)%3];if((x===a&&y===b)||(x===b&&y===a)){triangles.push(x,m,z,m,y,z);split=true;break;}}if(!split)triangles.push(...ids);}mesh.indices=triangles;
 }
 if(edges.length)refreshMeshShading(mesh,true);
}

/** Insert a continuous cut across crossing triangles; topology remains explicitly triangular. */
export function insertLoop(mesh:MeshData,axis:0|1|2,offset:number){
 const edges=new Map<string,[number,number]>();for(let i=0;i<mesh.indices.length;i+=3)for(let j=0;j<3;j++){const a=mesh.indices[i+j],b=mesh.indices[i+(j+1)%3],x=mesh.positions[a*3+axis]-offset,y=mesh.positions[b*3+axis]-offset;if(x*y<-1e-12)edges.set([a,b].sort((a,b)=>a-b).join(':'),[a,b]);}
 if(!edges.size)throw new Error('The cut plane does not cross any mesh edges');if(edges.size>2000)throw new Error('Cut crosses more than 2000 edges; refine a smaller mesh');
 const values=[...edges.values()];splitEdges(mesh,values,values.map(([a,b])=>(offset-mesh.positions[a*3+axis])/(mesh.positions[b*3+axis]-mesh.positions[a*3+axis])));
}
