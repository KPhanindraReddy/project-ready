'use strict';
const path = require('node:path');
const labels = {
  error:'Scan error', missing:'Missing', mismatch:'Wrong version', unknown:'Needs review',
  declared:'Listed only', 'found-unverified':'Version unchecked', 'optional-absent':'Optional, absent',
  present:'OK', detected:'Found', 'wrapper-found':'Wrapper found'
};
function explanation(r) {
  if (r.status === 'mismatch') return 'Found '+r.detail+'. Use a version matching '+r.requested+'.';
  if (r.status === 'missing' && r.type === 'env key') return 'Set this key in .env or in your environment.';
  if (r.status === 'missing' && r.type === 'tool') return 'Install '+r.name+' or add it to PATH.';
  if (r.status === 'missing' && r.type === 'python') return 'Install this dependency in the project virtual environment.';
  if (r.status === 'declared') return 'Listed in the project. Installation was not checked.';
  if (r.status === 'found-unverified') return 'Found '+(r.detail||'locally')+'. Compatibility was not checked.';
  if (r.status === 'detected') return 'Project file found.';
  return r.detail || ({present:'Available', 'optional-absent':'Optional dependency', unknown:'Check manually.'}[r.status]) || '';
}
const clean = value => String(value).replace(/[\x00-\x1f\x7f-\x9f]/g,' ');
function wrap(value,width) {
  let text=clean(value), lines=[];
  while(text.length>width){
    const space=text.lastIndexOf(' ',width);
    const end=space>0?space:width;
    lines.push(text.slice(0,end)); text=text.slice(end).trimStart();
  }
  lines.push(text); return lines;
}
module.exports = function report(root,findings) {
  if (!findings.length) return console.log('No recognized manifests or environment templates.');
  const groups=new Map();
  const isIssue=r=>['missing','mismatch','error'].includes(r.status);
  for(const r of findings){
    if(!groups.has(r.project))groups.set(r.project,[]);
    groups.get(r.project).push(r);
  }
  const issues=findings.filter(isIssue).length;
  console.log('Project Ready  |  '+issues+' '+(issues===1?'issue':'issues')+' to fix');
  for(const [project,items] of groups){
    console.log('\nProject: '+clean(project==='.'?path.basename(root):project));
    const rows=items.sort((a,b)=>Number(isIssue(b))-Number(isIssue(a))).map(r=>
      [labels[r.status]||r.status,r.name,r.requested||'-',explanation(r)]);
    const headers=['Status','Item','Required','Details / next step'];
    const width=Math.max(49,Math.min(process.stdout.columns||100,125));
    const widths=[0,1,2].map((i)=>Math.min(Math.floor(width*[0.19,0.24,0.15][i]),
      rows.reduce((max,row)=>Math.max(max,clean(row[i]).length),headers[i].length)));
    widths.push(width-widths.reduce((a,b)=>a+b,0)-9);
    function print(row){
      const cells=row.map((v,i)=>wrap(v,widths[i]));
      for(let line=0;line<Math.max(...cells.map(c=>c.length));line++){
        console.log(cells.map((c,i)=>(c[line]||'').padEnd(widths[i])).join(' | ').trimEnd());
      }
    }
    print(headers);
    console.log(widths.map(w=>'-'.repeat(w)).join('-+-'));
    rows.forEach(print);
  }
};
