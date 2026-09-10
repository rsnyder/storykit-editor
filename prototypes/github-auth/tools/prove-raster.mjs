/** Local workerd executes the production decoders, including compiled WebP. */
import { build } from 'esbuild';
import { Miniflare,convertV4MiniflareOptions } from 'miniflare';
import { readFileSync } from 'node:fs';
import { encode } from 'fast-png';
import jpeg from 'jpeg-js';
import encodeWebp,{init as initEncoder} from '@jsquash/webp/encode.js';
const root=new URL('../',import.meta.url).pathname;
const wasm=readFileSync(root+'node_modules/@jsquash/webp/codec/dec/webp_dec.wasm');
const buildResult=await build({stdin:{contents:`import {validateRaster} from './src/raster-validation.js';export default {async fetch(request){try{const result=await validateRaster(new Uint8Array(await request.arrayBuffer()));return Response.json(result);}catch(error){return Response.json({error:error.message},{status:400});}}}`,resolveDir:root},bundle:true,format:'esm',write:false,plugins:[{name:'compiled-wasm',setup(b){b.onResolve({filter:/\.wasm$/},()=>({path:'./decoder.wasm',external:true}));}}]});
const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'proof',compatibilityDate:'2026-09-06',modulesRoot:root,modules:[{type:'ESModule',path:root+'proof.js',contents:buildResult.outputFiles[0].text},{type:'CompiledWasm',path:root+'decoder.wasm',contents:wasm}]}]}));
try {
  await initEncoder(await WebAssembly.compile(readFileSync(root+'node_modules/@jsquash/webp/codec/enc/webp_enc_simd.wasm')));
  const pixels=new Uint8Array(2000*2000*4).fill(255);
  const webp=await encodeWebp({width:2000,height:2000,data:pixels});
  const wr=await mf.dispatchFetch('http://proof/',{method:'POST',body:webp});console.log(JSON.stringify({mime:'webp',status:wr.status,result:await wr.json()}));
  for(const [width,height] of [[4,3],[2000,2000],[6000,4000]]){
    const data=new Uint8Array(width*height*4);for(let i=0;i<data.length;i+=4){data[i]=255;data[i+3]=255;}
    for(const [mime,bytes] of [['png',encode({width,height,data,channels:4})],['jpeg',jpeg.encode({width,height,data},70).data]]){
      const start=performance.now();const r=await mf.dispatchFetch('http://proof/',{method:'POST',body:bytes});
      console.log(JSON.stringify({mime,width,height,bytes:bytes.length,wallMs:Math.round(performance.now()-start),status:r.status,result:await r.json()}));
    }
  }
}finally{await mf.dispose();}
