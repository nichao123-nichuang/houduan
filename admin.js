const API_BASE='https://houduan-production-bf99.up.railway.app';
let _adminToken='',_lastBatchCodes=[],_turns=5,_count=1;

document.addEventListener('DOMContentLoaded',function(){
  const saved=localStorage.getItem('adminToken');
  if(saved){_adminToken=saved;showAdminView();}
  document.getElementById('loginForm').onsubmit=function(e){e.preventDefault();doLogin();};
  document.getElementById('platform').onchange=function(){document.getElementById('customFields').classList.toggle('hidden',this.value!=='9');};
});

async function doLogin(){
  const pwd=document.getElementById('pwd').value;
  try{
    const r=await fetch(API_BASE+'/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pwd})});
    const d=await r.json();
    if(!r.ok){document.getElementById('err').textContent=d.error||'登录失败';return;}
    _adminToken=d.adminToken;localStorage.setItem('adminToken',_adminToken);showAdminView();
  }catch(e){document.getElementById('err').textContent='网络错误';}
}

function showAdminView(){
  document.getElementById('loginView').classList.add('hidden');
  document.getElementById('adminView').classList.remove('hidden');
  loadAllData();
}

function logout(){_adminToken='';localStorage.removeItem('adminToken');location.reload();}

async function loadAllData(){
  await Promise.all([loadStats(),loadConfig(),refreshCodes(),refreshScripts()]);
}

async function loadStats(){
  try{
    const r=await fetch(API_BASE+'/api/admin/stats',{headers:{'x-admin-token':_adminToken}});
    if(r.status===401){logout();return;}
    const d=await r.json();
    document.getElementById('statTotal').textContent=d.totalCodes||0;
    document.getElementById('statUsed').textContent=d.usedCodes||0;
    document.getElementById('statActive').textContent=d.activeSessions||0;
  }catch(e){}
}

async function loadConfig(){
  try{
    const r=await fetch(API_BASE+'/api/admin/config',{headers:{'x-admin-token':_adminToken}});
    if(r.status===401){logout();return;}
    const d=await r.json();
    document.getElementById('platform').value=d.defaultPlatform||1;
    document.getElementById('customUrl').value=d.defaultCustomUrl||'';
    document.getElementById('customModel').value=d.defaultCustomModel||'';
    document.getElementById('keyStatus').textContent=d.hasApiKey?'✅ 后端已保存API密钥':'⚠️ 请填写API密钥并保存';
    document.getElementById('customFields').classList.toggle('hidden',d.defaultPlatform!==9);
  }catch(e){}
}

async function saveConfig(){
  const pid=parseInt(document.getElementById('platform').value);
  const apiKey=document.getElementById('apiKey').value.trim();
  const customUrl=pid===9?document.getElementById('customUrl').value.trim():'';
  const customModel=pid===9?document.getElementById('customModel').value.trim():'';
  toast('保存中...');
  try{
    const r=await fetch(API_BASE+'/api/admin/config',{method:'POST',headers:{'Content-Type':'application/json','x-admin-token':_adminToken},body:JSON.stringify({platformId:pid,apiKey,customUrl,customModel})});
    const d=await r.json();
    if(!r.ok){toast('⚠️ '+(d.error||'保存失败'));return;}
    toast('✅ 配置已保存');loadConfig();
  }catch(e){toast('⚠️ 网络错误');}
}

function selectTurns(n){
  _turns=n;document.querySelectorAll('#turnsSelector .turns-btn').forEach(b=>b.classList.remove('active'));
  event.target.classList.add('active');document.getElementById('customTurns').value='';
}
function selectCount(n){
  _count=n;document.querySelectorAll('#countSelector .turns-btn').forEach(b=>b.classList.remove('active'));
  event.target.classList.add('active');document.getElementById('customCount').value='';
}

async function generateCodes(){
  const pid=parseInt(document.getElementById('platform').value);
  const apiKey=document.getElementById('apiKey').value.trim();
  const customUrl=pid===9?document.getElementById('customUrl').value.trim():'';
  const customModel=pid===9?document.getElementById('customModel').value.trim():'';
  const customTurns=parseInt(document.getElementById('customTurns').value);
  const customCount=parseInt(document.getElementById('customCount').value);
  const turns=(customTurns&&customTurns>0)?customTurns:_turns;
  const count=(customCount&&customCount>0)?customCount:_count;
  if(pid===9&&!customUrl){toast('自定义平台需填写API地址');return;}
  if(count>500){toast('单次最多生成500张');return;}
  toast('生成中...');
  try{
    const r=await fetch(API_BASE+'/api/admin/generate-codes',{method:'POST',headers:{'Content-Type':'application/json','x-admin-token':_adminToken},body:JSON.stringify({platformId:pid,apiKey:apiKey||undefined,customUrl,customModel,turns,count})});
    const d=await r.json();
    if(!r.ok){toast('⚠️ '+(d.error||'生成失败'));return;}
    _lastBatchCodes=d.codes||[];
    document.getElementById('batchResult').classList.remove('hidden');
    document.getElementById('batchTitle').textContent=`已生成 ${d.count} 张短码（每张 ${turns} 回合）`;
    document.getElementById('batchList').innerHTML=_lastBatchCodes.map(c=>`<div class="batch-code" onclick="copyText('${c}')">${c}</div>`).join('');
    refreshCodes();toast(`✅ 已生成 ${d.count} 张兑换码`);
  }catch(e){toast('⚠️ 网络错误');}
}

async function refreshCodes(){
  try{
    const r=await fetch(API_BASE+'/api/admin/codes',{headers:{'x-admin-token':_adminToken}});
    if(r.status===401){logout();return;}
    const codes=await r.json();
    const list=document.getElementById('codeList');
    if(!codes||!codes.length){list.innerHTML='<p style="color:var(--text3);font-size:0.85rem;text-align:center;padding:20px">暂无兑换码</p>';return;}
    list.innerHTML=codes.map(c=>{
      const status=c.activatedBy==='已激活'?'<span style="color:#ff6b6b">已激活</span>':'<span style="color:#6bffa0">未使用</span>';
      return `<div class="code-item"><div><div class="code" onclick="copyText('${c.code}')">${c.code}</div><div class="meta">${c.totalTurns}回合 · ${status}${c.remaining>=0?' · 剩'+c.remaining:''}</div></div><div class="del" onclick="deleteCode('${c.code}')">✕</div></div>`;
    }).join('');
  }catch(e){}
}

async function clearAllCodes(){
  if(!confirm('确定要清空所有兑换码吗？此操作不可恢复。'))return;
  try{
    const r=await fetch(API_BASE+'/api/admin/clear-codes',{method:'POST',headers:{'x-admin-token':_adminToken}});
    const d=await r.json();
    if(!r.ok){toast('⚠️ '+(d.error||'清空失败'));return;}
    toast('✅ 已清空');refreshCodes();loadStats();
  }catch(e){toast('⚠️ 网络错误');}
}

async function deleteCode(code){
  if(!confirm(`确定删除兑换码 ${code} 吗？`))return;
  try{
    const r=await fetch(API_BASE+'/api/admin/codes/'+encodeURIComponent(code),{method:'DELETE',headers:{'x-admin-token':_adminToken}});
    const d=await r.json();
    if(!r.ok){toast('⚠️ '+(d.error||'删除失败'));return;}
    toast('✅ 已删除');refreshCodes();loadStats();
  }catch(e){toast('⚠️ 网络错误');}
}

async function refreshScripts(){
  try{
    const r=await fetch(API_BASE+'/api/admin/scripts/all',{headers:{'x-admin-token':_adminToken}});
    if(r.status===401){logout();return;}
    const d=await r.json();
    const scripts=d.scripts||[];
    document.getElementById('statPending').textContent=scripts.filter(s=>s.status==='pending').length;
    document.getElementById('statApproved').textContent=scripts.filter(s=>s.status==='approved').length;
    document.getElementById('statRejected').textContent=scripts.filter(s=>s.status==='rejected').length;
    const list=document.getElementById('scriptsList');
    if(!scripts.length){list.innerHTML='<p style="color:var(--text3);font-size:0.85rem;text-align:center;padding:20px">暂无剧本</p>';return;}
    list.innerHTML=scripts.map(s=>{
      const badge=s.status==='approved'?'<span class="badge badge-green">已通过</span>':s.status==='pending'?'<span class="badge badge-yellow">待审核</span>':'<span class="badge badge-red">已拒绝</span>';
      const actions=s.status==='pending'?`<button class="btn btn-sm btn-primary" onclick="reviewScript('${s.id}','approve')">✅ 通过</button><button class="btn btn-sm btn-danger" onclick="reviewScript('${s.id}','reject')">❌ 拒绝</button>`:`<button class="btn btn-sm btn-ghost" onclick="reviewScript('${s.id}','delete')" style="color:var(--red)">🗑️ 删除</button>`;
      return `<div class="script-item"><div class="title">${s.title||'未命名'} ${badge}</div><div class="meta">作者: ${s.author_name||'匿名'} · 类型: ${s.tag||'冒险'}</div><div class="desc">${(s.description||'无简介').substring(0,100)}${(s.description||'').length>100?'...':''}</div><div class="actions">${actions}</div></div>`;
    }).join('');
  }catch(e){}
}

async function reviewScript(id,action){
  if(action==='delete'&&!confirm('确定删除这个剧本吗？不可恢复。'))return;
  const note=action==='reject'?prompt('请输入拒绝原因（可选）')||'':'';
  try{
    const r=await fetch(API_BASE+'/api/admin/script/review',{method:'POST',headers:{'Content-Type':'application/json','x-admin-token':_adminToken},body:JSON.stringify({id,action,reviewNote:note})});
    const d=await r.json();
    if(!r.ok){toast('⚠️ '+(d.error||'操作失败'));return;}
    toast(action==='approve'?'✅ 已通过':action==='delete'?'🗑️ 已删除':'❌ 已拒绝');
    refreshScripts();
  }catch(e){toast('⚠️ 网络错误');}
}

function changePassword(){
  const old=prompt('请输入当前密码');if(!old)return;
  const newPwd=prompt('请输入新密码（至少4位）');if(!newPwd||newPwd.length<4){toast('密码太短');return;}
  const confirm=prompt('请再次输入新密码');if(newPwd!==confirm){toast('两次密码不一致');return;}
  fetch(API_BASE+'/api/admin/change-password',{method:'POST',headers:{'Content-Type':'application/json','x-admin-token':_adminToken},body:JSON.stringify({oldPassword:old,newPassword:newPwd})})
    .then(r=>r.json().then(d=>{if(!r.ok){toast('⚠️ '+(d.error||'修改失败'));return;}toast('✅ 密码已修改');}))
    .catch(()=>toast('⚠️ 网络错误'));
}

function copyAllCodes(){
  if(!_lastBatchCodes.length){toast('没有可复制的兑换码');return;}
  copyText(_lastBatchCodes.join('\\n'),`✅ 已复制 ${_lastBatchCodes.length} 张兑换码`);
}

function copyText(text,msg){
  if(navigator.clipboard){navigator.clipboard.writeText(text).then(()=>toast(msg||'✅ 已复制')).catch(()=>fallbackCopy(text,msg));}
  else{fallbackCopy(text,msg);}
}
function fallbackCopy(text,msg){
  const ta=document.createElement('textarea');ta.value=text;ta.style.cssText='position:fixed;top:-9999px;left:-9999px;opacity:0;';document.body.appendChild(ta);ta.select();
  try{document.execCommand('copy');toast(msg||'✅ 已复制');}catch(e){toast('复制失败');}
  document.body.removeChild(ta);
}

function toast(msg){
  const t=document.createElement('div');t.className='toast';t.textContent=msg;document.body.appendChild(t);setTimeout(()=>t.remove(),2500);
}
