#!/usr/bin/env node
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const arg=(n,f)=>{const i=process.argv.indexOf("--"+n);return i>=0&&process.argv[i+1]?process.argv[i+1]:f};
const root=path.resolve(arg("root",path.join(__dirname,"dist")));
const host=arg("host","127.0.0.1");
const port=Number(arg("port","5173"));
const runtimeHost=arg("runtime-host","127.0.0.1");
const runtimePort=Number(arg("runtime-port","6121"));
const statusPath="/yuvi-daily/status";
const TYPES={".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".json":"application/json",".svg":"image/svg+xml",".png":"image/png",".woff2":"font/woff2",".map":"application/json"};
const xdg=()=>{const v=process.env.XDG_DATA_HOME;return v&&path.isAbsolute(v)?v:path.join(process.env.HOME||"",".local/share")};
async function dailyStatus(res){res.setHeader("Cache-Control","no-store");res.setHeader("Content-Type","application/json");try{const pointer=JSON.parse(fs.readFileSync(path.join(process.env.YUVI_SUPERVISOR_STATE_ROOT || path.join(xdg(),"YUVI/DesktopSupervisor"),"active-instance.json"),"utf8"));const endpoint=JSON.parse(fs.readFileSync(pointer.endpointFile,"utf8"));if(endpoint.host!=="127.0.0.1"||!Number.isInteger(endpoint.port)||endpoint.port<1||endpoint.port>65535||endpoint.instanceId!==pointer.instanceId||typeof endpoint.controlToken!=="string")throw new Error("bad");const response=await fetch("http://127.0.0.1:"+endpoint.port+"/v1/status",{headers:{"x-yuvi-control-token":endpoint.controlToken},signal:AbortSignal.timeout(3000),redirect:"error"});if(!response.ok)throw new Error("unavail");const snapshot=await response.json();if(snapshot.instanceId!==pointer.instanceId)throw new Error("stale");res.end(JSON.stringify({checkedAt:new Date().toISOString(),services:(snapshot.services||[]).map(s=>({id:s.id,status:s.status,managed:s.ownership==="owned"||s.ownership==="managed"}))}));}catch{res.statusCode=503;res.end(JSON.stringify({error:"Supervisor status unavailable"}));}}
function proxy(req,res,targetPath){const upstream=http.request({hostname:runtimeHost,port:runtimePort,path:targetPath,method:req.method,headers:{...req.headers,host:runtimeHost+":"+runtimePort}},up=>{res.writeHead(up.statusCode||502,up.headers);up.pipe(res);});upstream.on("error",()=>{res.statusCode=502;res.end("Bad Gateway")});req.pipe(upstream);}
function safeJoin(base,reqPath){const decoded=decodeURIComponent((reqPath||"/").split("?")[0]);const joined=path.normalize(path.join(base,decoded==="/"?"index.html":decoded));return joined.startsWith(base)?joined:null;}
function rejectUpgrade(socket,status,text){if(socket.destroyed)return;socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);}
function proxyUpgrade(req,socket,head){
  const url=req.url||"";
  if(url!=="/ws"&&!url.startsWith("/ws?")){rejectUpgrade(socket,404,"Not Found");return;}
  const upstream=net.connect({host:runtimeHost,port:runtimePort});
  upstream.once("connect",()=>{
    const headers=[];
    for(let i=0;i<req.rawHeaders.length;i+=2){
      const name=req.rawHeaders[i]||"";
      const value=req.rawHeaders[i+1]||"";
      headers.push(name+": "+(name.toLowerCase()==="host"?runtimeHost+":"+runtimePort:value));
    }
    upstream.write((req.method||"GET")+" "+url+" HTTP/"+req.httpVersion+"\r\n"+headers.join("\r\n")+"\r\n\r\n");
    if(head.length)upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.once("error",()=>rejectUpgrade(socket,502,"Bad Gateway"));
  socket.once("error",()=>upstream.destroy());
}
const server=http.createServer(async(req,res)=>{const url=req.url||"/";if(url===statusPath||url.startsWith(statusPath+"?")){if(req.method!=="GET"){res.statusCode=405;res.end("{}");return;}return dailyStatus(res);}if(url.startsWith("/api/")||url==="/api")return proxy(req,res,url.replace(/^\/api/,"")||"/");if(url.startsWith("/live2d"))return proxy(req,res,url);let file=safeJoin(root,url);if(!file){res.statusCode=400;res.end("Bad path");return;}if(fs.existsSync(file)&&fs.statSync(file).isDirectory())file=path.join(file,"index.html");if(!fs.existsSync(file)||!fs.statSync(file).isFile())file=path.join(root,"index.html");if(!fs.existsSync(file)){res.statusCode=404;res.end("Not found");return;}res.setHeader("Content-Type",TYPES[path.extname(file)]||"application/octet-stream");fs.createReadStream(file).pipe(res);});
server.on("upgrade",proxyUpgrade);
server.listen(port,host,()=>console.log(JSON.stringify({ok:true,event:"web.listening",url:"http://"+host+":"+port,root})));
