const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'offline-client');
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.webp':'image/webp'};
http.createServer((req,res)=>{let p;try{p=decodeURIComponent(new URL(req.url,'http://localhost').pathname)}catch{res.writeHead(400).end('Bad request');return}
if(p==='/')p='/index.html';const f=path.resolve(root,'.'+p);if(!f.startsWith(root+path.sep)){res.writeHead(403).end('Forbidden');return}
fs.readFile(f,(err,data)=>{if(err){res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'}).end('Not found: '+p);return}
res.writeHead(200,{'Content-Type':mime[path.extname(f)]||'application/octet-stream','Cache-Control':'no-store'});res.end(data)})}).listen(8000,'127.0.0.1',()=>console.log('娜緹夏天堂單機原型：http://127.0.0.1:8000'));