const fs=require('fs'),path=require('path');
const r='/Users/caner/.local/drips-agent/workspace/ILN-Smart-Contract/sdk/src';
let b=0,l=0,n=0;
function walk(d){
  for(const f of fs.readdirSync(d)){
    const p=path.join(d,f),s=fs.statSync(p);
    if(s.isDirectory())walk(p);
    else if(f.endsWith('.js')&&!f.endsWith('.test.js')){
      const data=fs.readFileSync(p);
      b+=data.length;
      const text=data.toString('utf8');
      l+=text.split('\n').length-(text.endsWith('\n')?0:0);
      n++;
    }
  }
}
walk(r);
console.log('FILES='+n);
console.log('BYTES='+b);
console.log('LINES='+l);
console.log('KB='+(b/1024).toFixed(2));
