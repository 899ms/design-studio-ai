import {useState} from 'react';
import type {DesignDocument} from '../shared/schema';
import {mutateDocument} from '../shared/operations';

export function AssetReplacement({doc,onDocument}:{doc:DesignDocument;onDocument:(doc:DesignDocument)=>void}){
  const [source,setSource]=useState(''),[replacement,setReplacement]=useState(''),[error,setError]=useState('');
  const original=doc.assets.find(a=>a.id===source);
  if(doc.assets.length<2)return null;
  return <details><summary>Replace an asset in the design</summary>
    <label>Current asset<select aria-label="Current asset" value={source} onChange={e=>{setSource(e.target.value);setReplacement('');}}><option value="">Choose asset</option>{doc.assets.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
    <label>Replacement<select aria-label="Replacement asset" value={replacement} onChange={e=>setReplacement(e.target.value)}><option value="">Choose replacement</option>{doc.assets.filter(a=>a.id!==source&&a.mimeType.split('/')[0]===original?.mimeType.split('/')[0]).map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
    <p>Updates existing uses and keeps their transforms and animation. Both source files stay in your library. Replacement models need matching clip names.</p>
    <button disabled={!source||!replacement} onClick={()=>{try{onDocument(mutateDocument(doc,[{op:'replace-asset',assetId:source,replacementId:replacement}]));setError('');}catch(e){setError((e as Error).message);}}}>Replace uses</button>
    {error&&<p role="alert">{error}</p>}
  </details>;
}
