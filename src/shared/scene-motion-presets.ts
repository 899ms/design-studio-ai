import * as T from 'three';
import type { DesignNode } from './schema';
import { boneWorld, limitedRotation, solveIK } from './scene-rigging';
export function motionFrames(node:DesignNode,preset:'idle'|'wag'|'walk'|'wing-flap'|'roar',start:number,duration:number,strength:number,wristLag=.15){
  const bones=node.scene!.bones!,rest=boneWorld(bones),feet=bones.map((b,i)=>({name:b.name,index:i,position:new T.Vector3().setFromMatrixPosition(rest[i])})).filter(b=>b.name.endsWith('Foot'));
  const required=preset==='roar'?['head','neck','jaw','jawTip']:preset==='wing-flap'?['Left','Right'].flatMap(side=>['Shoulder','Elbow','Wrist','Finger1','Finger2','Finger3'].map(joint=>`wing${side}${joint}`)):[];
  const missing=required.filter(name=>!bones.some(b=>b.name===name));if(missing.length)throw new Error(`Rig lacks the named bones required for ${preset}: ${missing.join(', ')}`);
  const height=node.scene?.mesh?new T.Box3().setFromArray(node.scene.mesh.positions).getSize(new T.Vector3()).y:1;
  return Array.from({length:25},(_,i)=>{
    const phase=i/24,angle=phase*Math.PI*2,values:Record<string,number>={};
    const rotate=(name:string,axis:number,offset:number)=>{const j=bones.findIndex(b=>b.name===name);if(j<0)return;const rotation=[...(bones[j].rotation??bones[j].bindRotation??[0,0,0])];rotation[axis]+=offset*strength;values[`scene.bones.${j}.rotation.${'xyz'[axis]}`]=limitedRotation(bones[j],rotation)[axis];};
    if(preset==='wing-flap'){
      for(const side of ['Left','Right']){const sign=side==='Left'?-1:1;
        rotate(`wing${side}Shoulder`,2,sign*Math.sin(angle)*38);
        rotate(`wing${side}Elbow`,2,sign*Math.sin(angle-wristLag*Math.PI)*22);
        rotate(`wing${side}Wrist`,2,sign*Math.sin(angle-wristLag*Math.PI*2)*28);
        bones.filter(b=>new RegExp(`^wing${side}Finger[1-5]$`).test(b.name)).forEach((bone,j)=>rotate(bone.name,2,sign*Math.sin(angle-wristLag*Math.PI*2-j*.08)*12));
      }
      bones.filter(b=>/^tail[1-3]$/.test(b.name)).forEach((bone,j)=>rotate(bone.name,0,Math.sin(angle-j*.3)*4));
    }else if(preset==='roar'){
      const envelope=Math.sin(Math.PI*phase)**2;
      rotate('jaw',0,42*envelope);rotate('head',0,-16*envelope);rotate('neck',0,-9*envelope);
      bones.filter(b=>/^tail[1-3]$/.test(b.name)).forEach((bone,j)=>rotate(bone.name,0,-7*envelope*(1-j*.2)));
    }else if(preset==='walk'){
      const posed=structuredClone(bones);
      for(const foot of feet){const p=(phase+(/frontLeft|backRight/.test(foot.name)?0:.5))%1,target=foot.position.clone();
        // The stance half moves backward at ground level; the swing half lifts and returns.
        const stride=height*.1*strength,lift=height*.07*strength;
        if(p<.5)target.z+=(.5-p*2)*stride;else {const swing=(p-.5)*2;target.z+=(-.5+swing)*stride;target.y+=Math.sin(swing*Math.PI)*lift;}
        solveIK(posed,foot.name,target.toArray(),2,110);
      }
      posed.forEach((b,j)=>{if(/Upper|Lower/.test(b.name))for(let axis=0;axis<3;axis++)values[`scene.bones.${j}.rotation.${'xyz'[axis]}`]=b.rotation?.[axis]??0;});
    }else bones.forEach((b,j)=>{if(preset==='idle'&&b.name==='head')values[`scene.bones.${j}.rotation.x`]=(b.rotation?.[0]??0)+Math.sin(angle)*5*strength;if(preset==='wag'&&b.name.startsWith('tail'))values[`scene.bones.${j}.rotation.z`]=(b.rotation?.[2]??0)+Math.sin(angle*2-j*.2)*22*strength;});
    if(!Object.keys(values).length)throw new Error(`Rig lacks the named bones required for ${preset}`);
    return {time:start+phase*duration,values};
  });
}
