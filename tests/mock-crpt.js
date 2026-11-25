// Имитация сервиса проверки ЧЗ для тестов: node tests/mock-crpt.js, затем CRPT_BASE=http://127.0.0.1:9911 node server.js
// Имитация mobile.api.crpt.ru для тестов: статус зависит от последнего символа кода
const http=require('http');
let n=0;
http.createServer((req,res)=>{
  let b='';req.on('data',c=>b+=c);req.on('end',()=>{
    n++;
    if(req.url.startsWith('/v2/mobile/check')&&req.method==='POST'){
      const {code}=JSON.parse(b); const k=code.charCodeAt(code.length-2)%5;
      if(!code.startsWith('{FNC1}01')){res.writeHead(400,{'content-type':'application/json'});return res.end('{"codeFounded":false}');}
      const st=['INTRODUCED','INTRODUCED','APPLIED','RETIRED',null][k];
      res.writeHead(200,{'content-type':'application/json'});
      if(st===null) return res.end(JSON.stringify({codeFounded:false}));
      return res.end(JSON.stringify({codeFounded:true,checkResult:true,category:'grocery',productName:'Смола Шу пуэра',groceryData:{status:st,ownerName:'ИП Краснова С.Т.',ownerInn:'780632012138'}}));
    }
    res.writeHead(404);res.end();
  });
}).listen(9911,()=>console.log('mock up'));
