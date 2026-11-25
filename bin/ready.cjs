#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const semver = require('../vendor/semver');
const {spawnSync} = require('node:child_process');
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('project-ready [directory] [--json] [--strict]\nExit: 0 scan completed, 1 confirmed gaps with --strict, 2 incomplete or invalid input.');
  process.exit(0);
}
const paths = args.filter(a => !a.startsWith('--'));
if (paths.length > 1 || args.some(a => a.startsWith('--') && !['--strict','--json'].includes(a))) {
  console.error('Invalid arguments. Use --help.'); process.exit(2);
}
const root = path.resolve(paths[0] || '.');
const findings = [], skip = new Set(['node_modules','dist','build','target','vendor','bin','obj','__pycache__','Pods','coverage','venv','env']);
const read = f => fs.readFileSync(f,'utf8');
const json = f => JSON.parse(read(f));
const exists = fs.existsSync;
function emit(dir, type, name, requested, status, detail='') {
  findings.push({project:path.relative(root,dir)||'.',type,name,requested,status,detail});
}
function onPath(name) {
  if (!/^[a-z0-9-]+$/i.test(name)) return false;
  return (process.env.PATH||'').split(path.delimiter).filter(Boolean).some(d =>
    (process.platform==='win32' ? ['.exe','.cmd','.bat'] : ['']).some(ext=>{
      try {const f=path.join(d,name+ext);fs.accessSync(f,fs.constants.X_OK);return fs.statSync(f).isFile();} catch{return false;}
    }));
}
function inspectNode(dir) {
  const m=json(path.join(dir,'package.json'));
  const tool=(m.packageManager||'').split('@')[0] || (exists(path.join(dir,'pnpm-lock.yaml'))?'pnpm':exists(path.join(dir,'yarn.lock'))?'yarn':'npm');
  emit(dir,'tool',tool,'',onPath(tool)?'present':'missing','Package manager');
  const nodeRange=m.engines?.node;
  if(nodeRange) emit(dir,'runtime','node',nodeRange,!semver.validRange(nodeRange)?'unknown':semver.satisfies(process.version,nodeRange)?'present':'mismatch',process.version);
  let pnp=false;
  for(let d=dir;;d=path.dirname(d)){if(exists(path.join(d,'.pnp.cjs')))pnp=true;if(d===root)break;}
  for(const [scope,deps] of Object.entries({dev:m.devDependencies,peer:m.peerDependencies,runtime:m.dependencies,optional:m.optionalDependencies})){
    for(const [name,range] of Object.entries(deps||{})){
      if(!/^(?:@[\w.-]+\/)?[\w.-]+$/.test(name)||name.split('/').includes('..')||name==='.') throw Error('Invalid package name');
      let installed;
      for(let d=dir;;d=path.dirname(d)){
        const f=path.join(d,'node_modules',name,'package.json');
        if(exists(f)){installed=json(f).version;break;} if(d===root)break;
      }
      const optional=scope==='optional'||Object.hasOwn(m.optionalDependencies||{},name)||(scope==='peer'&&m.peerDependenciesMeta?.[name]?.optional);
      const status=installed ? (semver.validRange(range)&&semver.valid(installed)?(semver.satisfies(installed,range)?'present':'mismatch'):'found-unverified') : pnp?'unknown':optional?'optional-absent':'missing';
      emit(dir,'package/'+scope,name,range,status,installed|| (status==='missing'?'Install project dependencies using '+tool+'.':''));
    }
  }
}
function inspectPhp(dir){
  const m=json(path.join(dir,'composer.json'));
  const installedPath=path.join(dir,m.config?.['vendor-dir']||'vendor','composer','installed.json');
  const data=exists(installedPath)?json(installedPath):[];
  const pkgs=Array.isArray(data)?data:data.packages;
  for(const [name,range] of Object.entries({...m.require,...m['require-dev']})){
    const installed=pkgs.find(p=>p.name===name);
    emit(dir,'composer',name,range,installed?'found-unverified':'unknown',installed?.version||'Platform, virtual, or unverified dependency');
  }
}
function inspectGo(dir){
  let group=false;
  for(const line of read(path.join(dir,'go.mod')).split(/\r?\n/)){
    const s=line.replace(/\/\/.*$/,'').trim();
    if(/^require\s*\($/.test(s)){group=true;continue;} if(s===')'){group=false;continue;}
    const match=(group?s:s.startsWith('require ')?s.slice(8):'').match(/^(\S+)\s+(v\S+)$/);
    if(match)emit(dir,'go module',match[1],match[2],'declared');
  }
}
function envKeys(f){return [...read(f).matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z_0-9]*)\s*=/gm)].map(m=>m[1]);}
function inspect(dir,entries){
  const names=new Set(entries.filter(e=>e.isFile()).map(e=>e.name));
  const adapters=[['package.json',inspectNode],['composer.json',inspectPhp],['go.mod',inspectGo]];
  for(const [file,fn] of adapters)if(names.has(file)){emit(dir,'manifest',file,'','detected');fn(dir);}
  const pythonFiles=['pyproject.toml','requirements.txt','Cargo.toml',...Array.from(names).filter(n=>n.endsWith('.csproj'))].filter(n=>names.has(n));
  if(pythonFiles.length){
    const cmd=['python3','python','py'].find(onPath);
    for(const n of pythonFiles)emit(dir,'manifest',n,'','detected');
    if(!cmd){emit(dir,'reader','Python 3.11+','','error','Install Python for these manifest formats.');}
    else {
      const out=spawnSync(cmd,[...(cmd==='py'?['-3']:[]),'-I','-S',path.join(__dirname,'manifests.py'),dir,...pythonFiles],{encoding:'utf8',timeout:30000});
      if(out.status!==0) emit(dir,'reader','manifest inventory','','error','Check manifest syntax and Python 3.11+ availability.');
      else for(const row of JSON.parse(out.stdout))emit(dir,...row);
    }
  }
  for(const [f,t] of Object.entries({'go.mod':'go','Cargo.toml':'cargo','composer.json':'composer','Gemfile':'bundle','pubspec.yaml':'dart','pom.xml':'mvn','build.gradle':'gradle','build.gradle.kts':'gradle','Package.swift':'swift'})){
    if(names.has(f)){const wrapper=(t==='mvn'&&names.has('mvnw'))||(t==='gradle'&&names.has('gradlew'));
      emit(dir,'tool',t,'',wrapper?'wrapper-found':onPath(t)?'present':'missing',f);}
  }
  if(names.has('.env.example')){
    const actual=new Set([...Object.keys(process.env),...(names.has('.env')?envKeys(path.join(dir,'.env')):[])]);
    for(const k of envKeys(path.join(dir,'.env.example')))emit(dir,'env key',k,'',actual.has(k)?'present':'missing','Checks key presence only');
  }
}
function walk(dir){
  try{
    const entries=fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name));
    if(entries.some(e=>e.name==='pyvenv.cfg'))return;
    try{inspect(dir,entries);}catch(e){emit(dir,'scan','manifest','','error','Cannot read or parse a manifest.');}
    for(const e of entries)if(e.isDirectory()&&!e.name.startsWith('.')&&!skip.has(e.name))walk(path.join(dir,e.name));
  }catch{emit(dir,'scan','directory','','error','Cannot read directory.');}
}
walk(root);
const counts={};for(const r of findings)counts[r.status]=(counts[r.status]||0)+1;
if(args.includes('--json'))console.log(JSON.stringify({schema:1,counts,findings},null,2));
else require('./table.cjs')(root,findings);
process.exitCode=counts.error||!findings.length?2:args.includes('--strict')&&(counts.missing||counts.mismatch)?1:0;
