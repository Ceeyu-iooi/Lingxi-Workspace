(() => {
  'use strict';
  let token='';const query=location.hash.split('?')[1];
  if(query){token=new URLSearchParams(query).get('maintenance')||'';if(token)history.replaceState(null,'',location.pathname+location.search+'#/settings/data');}
  const request=async(method,route,body)=>{
    const response=await fetch(route,{method,credentials:'same-origin',headers:{'Content-Type':'application/json',...(token?{'X-Workbench-Maintenance':token}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const result=await response.json();if(!response.ok)throw Error(result.error||'资料操作失败');return result;
  };
  const size=n=>new Intl.NumberFormat('zh-CN',{maximumFractionDigits:2}).format((n||0)/1048576)+' MiB';
  window.profileManagement={async mount(host){
    const panel=document.createElement('section');panel.className='control-section';panel.innerHTML='<h3>资料位置与空间</h3><p data-location></p><p data-maintenance-note></p><div data-space></div><div class="control-actions"><button class="btn ghost" data-cache-clear>清理当前账号计算缓存</button><button class="btn ghost" data-open hidden>打开资料目录</button></div><div data-migration hidden><label class="field">新资料位置<input type="text" data-target placeholder="请选择空文件夹或填写绝对路径" autocomplete="off"></label><div class="control-actions"><button class="btn ghost" data-choose hidden>选择文件夹</button><button class="btn" data-move>校验并迁移</button><button class="btn ghost danger" data-remove-old hidden>删除迁移前的旧副本</button></div></div><p data-profile-error class="control-form-error" role="alert"></p><p data-profile-status role="status"></p>';
    host.append(panel);const q=s=>panel.querySelector(s),native=window.workbenchDesktop;
    const action=fn=>async event=>{const b=event.currentTarget;b.disabled=true;q('[data-profile-error]').textContent='';try{await fn();}catch(error){q('[data-profile-error]').textContent=error.message;}finally{b.disabled=false;}};
    const load=async()=>{const done=window.WorkbenchUI.busy(panel,'正在读取空间…');try{
      const [state,space]=await Promise.all([native?native.profile():request('GET','/api/profile/location'),request('GET','/api/profile/storage')]);if(!panel.isConnected)return;
      q('[data-location]').textContent=state.managementAvailable?state.root:'独立资料目录（本机维护入口可查看和迁移）';
      q('[data-maintenance-note]').textContent=state.managementAvailable?'迁移会暂停对应后台；校验完成后重启，原副本保留。':'全局迁移需要本机授权：在项目目录运行 python run_web.py --manage。';
      q('[data-space]').replaceChildren();
      for(const [label,key] of [['业务data目录（含用量数据库）','businessBytes'],['用量数据库','databaseBytes'],['价格证据压缩载荷','priceEvidenceCompressedBytes'],['计算缓存载荷','valuationPayloadBytes'],['备份','backupsBytes'],['浏览器缓存','browserCacheBytes'],['查询响应内存缓存','responseCacheBytes']]){const row=document.createElement('p');row.textContent=label+'：'+size(space[key]);q('[data-space]').append(row);}
      q('[data-migration]').hidden=!state.managementAvailable;q('[data-open]').hidden=!native;q('[data-choose]').hidden=!native;
      q('[data-remove-old]').hidden=!state.managementAvailable||!state.previous?.retained;
      if(state.previous?.retained)q('[data-profile-status]').textContent='迁移成功，旧副本保留在：'+state.previous.path;
    }finally{done();}};
    q('[data-cache-clear]').onclick=action(async()=>{if(!confirm('清理当前账号的可重建计算缓存并关闭三个Agent的参考计价？Token、价格证据和汇率保留。'))return;const result=await request('POST','/api/profile/clear-cache',{});window.dispatchEvent(new CustomEvent('workbench:features',{detail:result.features}));document.dispatchEvent(new CustomEvent('workbench:features',{detail:result.features}));await load();q('[data-profile-status]').textContent='计算缓存已清理，价格证据和真实用量保留。';});
    q('[data-open]').onclick=action(()=>native.open());q('[data-choose]').onclick=action(async()=>{const path=await native.choose();if(path)q('[data-target]').value=path;});
    q('[data-move]').onclick=action(async()=>{
      const target=q('[data-target]').value.trim();const plan=native?await native.preflight(target):await request('POST','/api/profile/preflight',{target});
      if(!native&&!confirm('暂停8765并迁移全部账户资料到 '+plan.target+'？需要复制约 '+size(plan.bytes)+'。原资料会保留。'))return;
      const result=native?await native.migrate(target):await request('POST','/api/profile/migrate',{target,confirm:true});if(result.cancelled)return;
      q('[data-profile-status]').textContent='正在迁移；后台校验并重启后恢复页面。';q('[data-move]').disabled=true;
      if(!native){let failures=0;const poll=async()=>{if(!panel.isConnected)return;try{const status=await request('GET','/api/profile/maintenance');if(status.status==='complete'){await load();q('[data-move]').disabled=false;return;}if(status.status==='failed'){q('[data-profile-error]').textContent=status.error;q('[data-move]').disabled=false;return;}failures=0;}catch{failures++;}if(failures>120){q('[data-profile-error]').textContent='后台尚未恢复，请检查本机维护窗口。';return;}setTimeout(poll,1000);};setTimeout(poll,1000);}
    });
    q('[data-remove-old]').onclick=action(async()=>{if(!native&&!confirm('删除迁移清单中未变化的旧资料文件？源码和新增文件保留。'))return;const result=native?await native.removeOld():await request('POST','/api/profile/remove-old',{confirm:true});if(!native)q('[data-profile-status]').textContent='已提交本机旧副本清理任务。';else if(!result.cancelled){await load();q('[data-profile-status]').textContent=result.changed?.length?'部分旧文件已变化，已保留。':'旧资料副本已清理。';}});
    try{await load();}catch(error){q('[data-profile-error]').textContent=error.message;}
  }};
})();
