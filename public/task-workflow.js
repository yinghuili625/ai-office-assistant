import {modelService,runAiJob} from './ai-service-info.js';
// 在同一页整理资料、生成正文并提交完成任务。
export function createTaskWorkflow({api,esc,icon,action,option,timeText,badge,toast,rerender,onTaskChange,openTaskForm,openRecords,openCompletion,navigate}) {
  const url=encodeURIComponent;
  const button=(name,label,cls='button',extra='')=>action(`tw-${name}`,label,cls,extra);
  const field=(label,name,value='',extra='')=>`<div class="field"><label for="tw-${name}">${label}</label><input id="tw-${name}" name="${name}" value="${esc(value)}" ${extra}></div>`;
  const area=(label,name,value='',extra='')=>`<div class="field"><label for="tw-${name}">${label}</label><textarea id="tw-${name}" name="${name}" ${extra}>${esc(value)}</textarea></div>`;
  const size=v=>v>=1048576?`${(v/1048576).toFixed(1)} 兆`:`${Math.max(1,Math.ceil(v/1024))} 千字节`;
  let id='',workspace=null,loading=false,error='',busy=false,progress='',loadToken=0,materialEditor=null;
  let selected=new Set(),selectedDocument='',draftTitle='',templateId='',customTemplate=null,consent=false,consentRevision='',confirmed=false;
  let partialTranscription='',sourceMenuKey='',removeKey='',regeneratePrompt=false,reloadPrompt=false,conflict=false;
  const editors=new Map();
  const taskDrafts=new Map();
  let activeRun=null;
  const current=()=>editors.get(selectedDocument);
  const dirty=d=>!!d&&(d.title!==d.savedTitle||d.content!==d.savedContent);
  const ready=()=>workspace?.settings?.enabled&&workspace.settings.model&&!workspace.settings.configError;
  function ensureContext(){if(activeRun&&(activeRun.token!==loadToken||activeRun.id!==id))throw new Error('任务已切换，已停止后续操作；原任务中已保存的资料仍保留。');}
  const post=async(path,body,method='POST')=>{ensureContext();const result=await api(path,{method,body:JSON.stringify(body)});ensureContext();return result;};
  const template=()=>customTemplate||workspace?.templates.find(t=>t.id===templateId);
  function items(){
    const files=workspace?.sourceFiles||[],linked=new Set(files.map(f=>f.materialId).filter(Boolean));
    return [...files.map(f=>({key:`s:${f.id}`,name:f.name,source:f,materialId:f.materialId,kind:f.kind})),...(workspace?.materials||[]).filter(m=>!linked.has(m.id)).map(m=>({key:`m:${m.id}`,name:m.title,materialId:m.id,kind:'文字'}))];
  }
  function resetConsent(){consent=false;consentRevision='';const el=document.querySelector('[name="generateConsent"]');if(el)el.checked=false;}
  function resetConfirmed(){confirmed=false;const el=document.querySelector('[name="finishConfirmed"]');if(el)el.checked=false;}
  function renderBusy(){
    const root=document.querySelector('.task-workspace');if(!root)return;
    root.querySelectorAll('button,input,select,textarea').forEach(el=>el.disabled=true);
    let el=root.querySelector('.tw-progress');if(!el){root.insertAdjacentHTML('afterbegin','<p class="tw-progress" role="status"></p>');el=root.querySelector('.tw-progress');}el.textContent=progress||'正在处理，请稍候…';
  }
  function status(message){ensureContext();progress=message;renderBusy();}
  async function run(work,success=''){
    if(busy)return;busy=true;const context={token:loadToken,id};activeRun=context;error='';progress='正在处理，请稍候…';renderBusy();
    try{await work();ensureContext();if(success)toast(success);}
    catch(e){if(context.token===loadToken&&context.id===id){error=e.message;if(e.partialText)partialTranscription=e.partialText;if(e.status===409&&current())conflict=true;toast(e.message,true);}}
    finally{busy=false;activeRun=null;progress='';rerender();}
  }
  async function reload(){
    const taskId=id,token=loadToken;const result=await api(`/api/tasks/${url(taskId)}/workspace`);
    if(taskId!==id||token!==loadToken){ensureContext();return null;}
    ensureContext();
    workspace=result;
    const keys=new Set(items().map(item=>item.key));selected=new Set([...selected].filter(key=>keys.has(key)));
    resetConsent();return workspace;
  }
  async function openDocument(documentId,force=false){
    const token=loadToken,taskId=id;
    if(force||!editors.has(documentId)){
      const {document:d}=await api(`/api/ai/documents/${url(documentId)}`);
      if(token!==loadToken||taskId!==id)return;
      editors.set(d.id,{...d,savedTitle:d.title,savedContent:d.content});
    }
    selectedDocument=documentId;resetConfirmed();conflict=false;reloadPrompt=false;regeneratePrompt=false;
  }
  async function open(taskId){
    if(id===taskId&&loading)return;
    if(id===taskId&&workspace){await run(reload);return;}
    if(id)taskDrafts.set(id,{editors:new Map(editors),materialEditor,selected:new Set(selected),selectedDocument,draftTitle,templateId,customTemplate,partialTranscription});
    id=taskId;workspace=null;loading=true;error='';materialEditor=null;selected=new Set();selectedDocument='';editors.clear();
    partialTranscription='';draftTitle='';templateId='';customTemplate=null;consent=false;confirmed=false;sourceMenuKey='';removeKey='';regeneratePrompt=false;reloadPrompt=false;conflict=false;
    const token=++loadToken;rerender();
    try{
      const result=await api(`/api/tasks/${url(taskId)}/workspace`);if(token!==loadToken)return;
      workspace=result;draftTitle=result.task.title;templateId=result.templates.find(t=>t.id==='builtin-minutes')?.id||result.templates[0]?.id||'';
      selected=new Set(items().slice(0,5).map(item=>item.key));
      const cached=taskDrafts.get(taskId);
      if(cached){
        const live=new Set(result.documents.map(d=>d.id));for(const [key,value]of cached.editors)if(live.has(key)&&dirty(value))editors.set(key,value);
        materialEditor=cached.materialEditor;selected=new Set([...cached.selected].filter(key=>items().some(item=>item.key===key)));draftTitle=cached.draftTitle;templateId=cached.templateId;customTemplate=cached.customTemplate;partialTranscription=cached.partialTranscription;
      }
      const latest=[...result.documents].sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
      const documentId=cached?.selectedDocument&&result.documents.some(d=>d.id===cached.selectedDocument)?cached.selectedDocument:latest?.id;
      if(documentId)await openDocument(documentId);
    }catch(e){if(token===loadToken)error=e.message;}
    finally{if(token===loadToken){loading=false;rerender();}}
  }
  function render(){
    if(loading)return '<div class="task-workspace"><div class="skeleton">正在打开任务…</div></div>';
    if(!workspace)return `<div class="task-workspace">${button('back','返回任务台账','link-button')}<div class="error-banner">${esc(error||'任务暂时不可用')} ${button('retry','重试','button small')}</div></div>`;
    const t=workspace.task;
    return `<div class="task-workspace">${button('back',`${icon('chevron')} 返回任务台账`,'link-button tw-back')}<header class="tw-header"><div><div class="tw-eyebrow">整理并完成 ${badge(t)}</div><h1>${esc(t.title)}</h1><div class="tw-meta"><span>负责人：${esc(t.owner)}</span><span>截止：${esc(t.dueDate)}</span><span>提交形式：${esc(t.submissionType||'文本')}</span></div></div><div class="button-row">${button('records','任务详情','button small')}${button('edit-task','编辑任务','button small')}</div></header><div class="tw-requirement"><strong>交付要求</strong><p>${esc(t.deliverable)}</p>${t.description?`<details><summary>补充说明</summary><p>${esc(t.description)}</p></details>`:''}</div>${busy?`<p class="tw-progress" role="status">${esc(progress)}</p>`:''}${error?`<div class="error-banner" role="alert">${esc(error)}</div>`:''}${t.status==='已完成'?completed():`<div class="tw-layout"><aside class="tw-inputs panel">${sources()}${templatePanel()}${generatePanel()}</aside><section class="tw-writing panel">${documentPanel()}</section></div>`}</div>`;
  }
  function sourceRow(item){
    const f=item.source,isOpen=removeKey===item.key,menuOpen=sourceMenuKey===item.key&&!isOpen;
    const menuId=`tw-source-menu-${url(item.key)}`;
    return `<div class="tw-source-row"><label class="tw-source-select"><input type="checkbox" name="sourceKeys" value="${esc(item.key)}" ${selected.has(item.key)?'checked':''}><span><strong>${esc(item.name)}</strong><small>${esc(item.kind)}${f?` · ${size(f.size)}`:''}${!item.materialId?' · 生成时识别':''}</small></span></label>${button('source-menu','更多','link-button tw-source-more',`data-key="${esc(item.key)}" aria-label="${esc(item.name)}的操作" aria-expanded="${menuOpen}" aria-controls="${esc(menuId)}"`)}<div id="${esc(menuId)}" class="tw-source-options" role="group" aria-label="${esc(item.name)}的操作选项" ${menuOpen?'':'hidden'}>${f?`<a href="/api/tasks/${url(id)}/sources/${url(f.id)}/download" download>下载原件</a>`:''}${item.materialId?button('material-open','查看／修改文字','link-button',`data-id="${esc(item.materialId)}"`):'<span class="hint">生成时自动识别正文</span>'}${button('remove','删除','link-button danger',`data-key="${esc(item.key)}"`)}</div>${isOpen?`<div class="tw-inline-confirm tw-source-confirm"><p>确认删除此资料？已生成文档的来源记录会保留。</p><div class="button-row">${button('remove-cancel','取消','button small')}${button('remove-confirm','确认删除','button small danger',`data-key="${esc(item.key)}"`)}</div></div>`:''}</div>`;
  }
  function sources(){
    const list=items();
    return `<div class="tw-input-section"><div class="tw-section-heading"><h2>素材</h2><span id="tw-source-count">已选 ${selected.size} / 5</span></div><label class="button tw-upload" for="tw-source-file">${icon('upload')} 上传素材</label><input class="tw-file-input" id="tw-source-file" type="file" multiple accept=".docx,.txt,.md,.csv,.mp3,.wav,.m4a,.webm,.mp4,.ogg,.flac,.png,.jpg,.jpeg,.webp"><p class="hint">会议记录、录音或图片，可多选。</p>${list.length?`<div class="tw-sources">${list.map(sourceRow).join('')}</div>`:'<p class="tw-source-empty">上传本次资料，或粘贴会议记录。</p>'}<details class="tw-paste" ${materialEditor?'open':''}><summary>粘贴／修改文字资料</summary>${materialEditor?materialForm():button('material-new','粘贴会议记录','button small')}</details></div>`;
  }
  function materialForm(){const m=materialEditor;return `<form id="tw-material-form" class="tw-material-form">${field('资料名称','materialTitle',m.title,'required maxlength="200"')}${area('资料正文','materialContent',m.content,'required maxlength="60000" rows="8"')}<div class="button-row"><button type="submit" class="button small">保存资料</button>${button('material-close','关闭','link-button')}</div>${m.discardPrompt?`<p class="hint">修改尚未保存。${button('material-discard','放弃修改','link-button danger')}</p>`:''}<span id="tw-material-status" class="hint">${m.dirty?'尚未保存，生成时会先保存。':''}</span></form>`;}
  function templatePanel(){
    const t=template();
    return `<div class="tw-input-section"><div class="tw-section-heading"><h2>模板</h2><label class="link-button" for="tw-template-file">上传模板</label><input class="tw-file-input" id="tw-template-file" type="file" accept=".docx,.txt,.md,.csv"></div><label class="visually-hidden" for="tw-template-choice">选择模板</label><select id="tw-template-choice" name="templateId">${customTemplate?option('__custom','__custom',`本次：${customTemplate.name}`):''}${workspace.templates.map(t=>option(t.id,customTemplate?'__custom':templateId,t.name)).join('')}</select>${customTemplate?`<div class="tw-custom-label"><span>仅用于本次文档</span>${button('template-clear','清除上传模板','link-button')}</div>`:''}${t?`<details class="tw-template-details"><summary>查看／调整模板内容</summary><div class="tw-template-fields">${field('模板名称','templateName',t.name,'maxlength="100"')}${area('模板正文与写作要求','templateContent',t.content,'maxlength="20000" rows="9"')}</div></details>`:''}</div>`;
  }
  function generatePanel(){
    const s=workspace.settings||{},services=[['文档','text'],['录音','transcription'],['图片','vision']].map(([label,target])=>({label,...modelService(s,target)}));
    const summary=services.map(service=>{let host=service.baseUrl||'未配置';try{host=new URL(host).host;}catch{}return `<div class="tw-model"><span>${service.label}：${esc(host)}</span><strong>${esc(service.model||'未配置模型')}</strong></div>`;}).join('');
    return `<div class="tw-input-section tw-generation">${summary}<details class="tw-service-details"><summary>发送范围与文件支持</summary><p>文档模型接收任务要求、所选文字素材及模板；待识别录音、图片发往各自的服务。未勾选的原件不发送，模板只参考结构。</p>${services.map(service=>`<p>${service.label}地址：${esc(service.baseUrl||'未配置')}</p>`).join('')}<p>文档／模板最大 1 兆。录音原件最大 100 兆；千问支持最长 4 小时并在本机按 3 分钟分段，其他转写接口最大 20 兆。图片最大 10 兆，千问图片建议原图不超过 7 兆。每次最多选 5 份素材。</p></details>${!ready()?'<p class="hint">请先到「AI 文档 → 模型设置」配置并启用模型。</p>':''}<label class="ai-check tw-consent"><input type="checkbox" name="generateConsent" ${consent?'checked':''}><span>我同意按上述服务配置发送任务要求、所选素材（含待识别录音、图片）和模板</span></label>${partialTranscription?`<details class="tw-history" open><summary>已转写部分（完整转写尚未成功）</summary><p class="hint">可复制下面的文字另存为资料，原录音仍保留。再次转写会重新发送录音。</p><textarea rows="8" readonly aria-label="已完成的部分转写文字">${esc(partialTranscription)}</textarea></details>`:''}${regeneratePrompt?`<div class="tw-inline-confirm"><p>当前正文有未保存修改。继续生成会打开一份新草稿，当前修改仍会保留在原草稿中；离开页面前请保存。</p><div class="button-row">${button('generate-cancel','取消','button small')}${button('generate-confirm','继续生成','button small primary')}</div></div>`:''}${button('generate',`${icon('edit')} ${current()?'重新生成':'AI 生成'}`,'button primary tw-generate',!ready()?'disabled':'')}</div>`;
  }
  function documentPanel(){
    const d=current(),canFinish=d&&['文本','不限'].includes(workspace.task.submissionType||'文本');
    return `<div class="tw-writing-heading"><h2>正文</h2>${workspace.documents.length>1?`<label class="tw-draft-picker"><span>历史草稿</span><select name="documentId" aria-label="选择历史草稿">${workspace.documents.map(doc=>option(doc.id,selectedDocument,`${doc.title} · 第 ${doc.revision} 版${dirty(editors.get(doc.id))?'（未保存）':''}`)).join('')}</select></label>`:''}<span id="tw-document-status" class="hint">${d?(dirty(d)?'修改尚未保存':`已保存 · 第 ${d.revision} 版`):'生成后可直接修改'}</span></div><form id="tw-document-form" class="tw-document-form">${field('文档名称','documentTitle',d?.title||draftTitle,'required maxlength="200"')}${area('正文内容','documentContent',d?.content||'',`required maxlength="60000" rows="22" placeholder="上传素材并选择模板后，点击「AI 生成」。生成的正文将在这里显示，可直接修改。" ${!d?'disabled':''}`)}${conflict?`<div class="tw-conflict"><p>文档版本发生变化，当前编辑内容已保留。请先复制需要保留的正文，再读取最新版本。</p>${reloadPrompt?`<div class="button-row">${button('reload-cancel','取消','button small')}${button('reload-confirm','放弃当前修改并重新读取','button small')}</div>`:button('reload-document','重新读取最新版本','button small')}</div>`:''}<div class="tw-document-actions"><button type="submit" class="button" ${!d?'disabled':''}>保存草稿</button>${button('manual-complete','直接上传成稿','link-button')}</div></form><form id="tw-finish-form" class="tw-finish-form"><label class="ai-check"><input type="checkbox" name="finishConfirmed" ${confirmed?'checked':''} ${!canFinish?'disabled':''}><span>我已核对内容，符合任务交付要求</span></label>${!['文本','不限'].includes(workspace.task.submissionType||'文本')?`<p class="hint">本任务要求${esc(workspace.task.submissionType)}，请通过“直接上传成稿”提交相应文件。</p>`:''}<button type="submit" class="button primary" ${!canFinish?'disabled':''}>保存并提交，完成任务</button></form>${d?`<details class="tw-history"><summary>生成记录与来源</summary><p class="hint">${esc(d.model||'')} · ${timeText(d.createdAt)}<br>模板：${esc(d.templateSnapshot?.name||'')}</p>${(d.sourceSnapshot||d.sources||[]).map(s=>`<h4>${esc(s.title||'来源资料')}</h4><pre>${esc(s.content||'')}</pre>`).join('')}<h4>原始初稿</h4><pre>${esc(d.originalContent||'')}</pre></details>`:''}`;
  }
  function completed(){const t=workspace.task;return `<section class="panel tw-complete-panel"><div class="tw-completed">${icon('checkCircle')}<div><h2>任务已完成</h2><p>${timeText(t.completedAt)}</p></div></div><div class="tw-submitted">${(t.attachments||[]).map(a=>`<article><div><strong>${esc(a.name)}</strong><p>${timeText(a.uploadedAt)}</p></div><div class="button-row"><a class="button small" href="/api/attachments/${url(a.id)}" download>${icon('download')} 下载</a>${action('delete-attachment','删除','link-button danger',`data-id="${esc(a.id)}" data-task-id="${esc(id)}"`)}</div></article>`).join('')}</div><div class="button-row">${button('reopen','重新打开任务','button')}${button('records','查看记录与已删除材料','link-button')}</div></section>`;}
  async function saveMaterial(){
    if(!materialEditor)return;const m=materialEditor;
    if(!m.title.trim()||!m.content.trim())throw new Error('请填写资料名称和正文。');
    const r=await post(m.id?`/api/ai/materials/${url(m.id)}`:'/api/ai/materials',{title:m.title,content:m.content,kind:'素材',taskId:id},m.id?'PATCH':'POST');
    materialEditor={...r.material,dirty:false};await reload();
    const item=items().find(item=>item.materialId===r.material.id);if(!m.id&&item&&selected.size<5)selected.add(item.key);
    return r.material;
  }
  async function generate(){
    if(!consent)throw new Error('请先勾选同意发送所选资料至上述模型服务。');
    const approvedRevision=consentRevision;
    if(materialEditor?.dirty&&!materialEditor.id&&selected.size>=5)throw new Error('已选 5 份素材，请先取消一份，再将正在粘贴的文字一同用于生成。');
    const selectedBeforeSave=new Set(selected);
    if(materialEditor?.dirty){status('正在保存文字资料…');await saveMaterial();for(const key of selectedBeforeSave)selected.add(key);}
    ensureContext();if(!approvedRevision||workspace.settings.configRevision!==approvedRevision)throw new Error('模型配置已变化，请重新核对服务地址并勾选同意后再生成。');
    const chosen=items().filter(item=>selected.has(item.key));
    if(!chosen.length||chosen.length>5)throw new Error('请选择 1 至 5 份素材。');
    const t=template();if(!t?.name?.trim()||!t?.content?.trim())throw new Error('请选择或上传有效模板。');
    if(!ready())throw new Error('请先配置并启用文档模型。');
    if(chosen.some(item=>item.source?.kind==='录音'&&!item.materialId)&&!workspace.settings.transcriptionModel)throw new Error('所选录音需要转写模型，请在模型设置中填写，或暂时取消勾选该录音。');
    const title=current()?.title||draftTitle;if(!title.trim())throw new Error('请填写文档名称。');
    const materialIds=[];
    for(const item of chosen){
      if(item.materialId){materialIds.push(item.materialId);continue;}
      status(`正在识别：${item.name}`);
      try{const r=await runAiJob(api,`/api/tasks/${url(id)}/sources/${url(item.source.id)}/extract-jobs`,{consent:true,configRevision:approvedRevision},message=>{if(activeRun?.token===loadToken)status(`${item.name}：${message}`);});ensureContext();materialIds.push(r.material.id);partialTranscription='';}
      catch(e){await reload();const failure=new Error(`“${item.name}”识别失败：${e.message} 原件已保留，可取消勾选后重试。`);failure.partialText=e.partialText;throw failure;}
    }
    status('正在生成正文…');
    const body={title,materialIds,referenceIds:[],consent:true,configRevision:approvedRevision,...(customTemplate?{template:{name:customTemplate.name,content:customTemplate.content}}:{templateId})};
    let r;try{r=await post(`/api/tasks/${url(id)}/draft`,body);}catch(e){await reload();throw e;}await reload();await onTaskChange();ensureContext();await openDocument(r.document.id);regeneratePrompt=false;
  }
  async function onAction(name,el){
    if(busy)return;const target=el.dataset.id;
    if(name==='back'){navigate('tasks');return;}
    if(name==='records'){openRecords(id);return;}
    if(name==='edit-task'){openTaskForm(id);return;}
    if(name==='manual-complete'){openCompletion(id);return;}
    if(name==='retry'){workspace=null;await open(id);return;}
    if(name==='material-new'){materialEditor={id:'',title:'会议记录',content:'',dirty:false};rerender();return;}
    if(name==='material-close'){if(materialEditor?.dirty)materialEditor.discardPrompt=true;else materialEditor=null;rerender();return;}
    if(name==='material-discard'){materialEditor=null;rerender();return;}
    if(name==='material-open'){if(materialEditor?.dirty&&materialEditor.id!==target){error='当前文字资料尚未保存，请先保存或关闭编辑。';rerender();return;}await run(async()=>{if(materialEditor?.id===target)return;const r=await api(`/api/ai/materials/${url(target)}`);ensureContext();materialEditor={...r.material,dirty:false};});return;}
    if(name==='source-menu'){sourceMenuKey=sourceMenuKey===el.dataset.key?'':el.dataset.key;removeKey='';rerender();return;}
    if(name==='remove'){removeKey=el.dataset.key;sourceMenuKey='';rerender();return;}
    if(name==='remove-cancel'){removeKey='';rerender();return;}
    if(name==='remove-confirm'){await run(async()=>{const item=items().find(item=>item.key===el.dataset.key);if(!item)return;if(item.materialId===materialEditor?.id&&materialEditor.dirty)throw new Error('此资料有未保存修改，请先保存或放弃修改。');if(item.source)await post(`/api/tasks/${url(id)}/sources/${url(item.source.id)}`,{},'DELETE');else await post(`/api/ai/materials/${url(item.materialId)}`,{},'DELETE');if(item.materialId===materialEditor?.id)materialEditor=null;selected.delete(item.key);removeKey='';await reload();},'资料已删除');return;}
    if(name==='template-clear'){customTemplate=null;resetConsent();rerender();return;}
    if(name==='generate-cancel'){regeneratePrompt=false;rerender();return;}
    if(name==='generate'||name==='generate-confirm'){
      if(name==='generate'&&dirty(current())){regeneratePrompt=true;rerender();return;}
      await run(generate,'正文已生成，可直接修改后提交');return;
    }
    if(name==='reload-document'){reloadPrompt=true;rerender();return;}
    if(name==='reload-cancel'){reloadPrompt=false;rerender();return;}
    if(name==='reload-confirm'){await run(()=>openDocument(selectedDocument,true),'已读取最新保存版本');return;}
    if(name==='reopen'){await run(async()=>{await post(`/api/tasks/${url(id)}`,{status:'进行中'},'PATCH');await reload();await onTaskChange();},'任务已重新打开');}
  }
  async function onSubmit(form){
    if(busy)return;
    if(form.id==='tw-material-form')await run(saveMaterial,'文字资料已保存');
    if(form.id==='tw-document-form')await run(async()=>{const d=current();if(!d)return;const r=await post(`/api/ai/documents/${url(d.id)}`,{title:d.title,content:d.content,revision:d.revision},'PATCH');editors.set(d.id,{...r.document,savedTitle:r.document.title,savedContent:r.document.content});conflict=false;resetConfirmed();await reload();},'草稿已保存');
    if(form.id==='tw-finish-form')await run(async()=>{const d=current();if(!d)throw new Error('请先生成正文。');if(!confirmed)throw new Error('请核对正文并勾选确认。');if(!d.title.trim()||!d.content.trim())throw new Error('文档名称和正文不能为空。');status('正在保存并提交…');const r=await post(`/api/tasks/${url(id)}/finish`,{documentId:d.id,revision:d.revision,title:d.title,content:d.content,confirmed:true});if(r.document)editors.set(d.id,{...r.document,savedTitle:r.document.title,savedContent:r.document.content});else editors.set(d.id,{...d,savedTitle:d.title,savedContent:d.content});confirmed=false;await reload();await onTaskChange();},'成稿已提交，任务已完成');
  }
  function input(target){
    const {name,value}=target;
    if(name==='materialTitle'&&materialEditor)materialEditor.title=value;
    if(name==='materialContent'&&materialEditor)materialEditor.content=value;
    if((name==='materialTitle'||name==='materialContent')&&materialEditor){materialEditor.dirty=true;materialEditor.discardPrompt=false;resetConsent();const el=document.querySelector('#tw-material-status');if(el)el.textContent='尚未保存，生成时会先保存。';}
    if(name==='templateName'||name==='templateContent'){if(!customTemplate)customTemplate={name:template()?.name||'',content:template()?.content||''};if(name==='templateName')customTemplate.name=value;else customTemplate.content=value;resetConsent();}
    const d=current();
    if(name==='documentTitle'){draftTitle=value;if(d)d.title=value;}
    if(name==='documentContent'&&d)d.content=value;
    if(name==='documentTitle'||name==='documentContent'){resetConfirmed();const el=document.querySelector('#tw-document-status');if(el)el.textContent=dirty(d)?'修改尚未保存':'已保存';}
  }
  const readBase64=file=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('文件读取失败，请重新选择。'));reader.readAsDataURL(file);});
  async function change(target){
    const {name}=target;
    if(target.id==='tw-source-file'){
      const files=[...target.files||[]];if(!files.length)return;
      await run(async()=>{
        const failures=[];let count=0,unselected=0;
        for(const file of files){
          try{
            const ext=file.name.split('.').at(-1).toLowerCase(),audio=['mp3','wav','m4a','webm','mp4','ogg','flac'],images=['png','jpg','jpeg','webp'];
            if(![...audio,...images,'docx','txt','md','csv'].includes(ext))throw new Error('不支持此文件格式');
            const max=(audio.includes(ext)?100:images.includes(ext)?10:1)*1048576;if(!file.size||file.size>max)throw new Error(`文件须非空且不超过 ${max/1048576} 兆`);
            status(`正在保存：${file.name}`);const r=await post(`/api/tasks/${url(id)}/sources`,{file:{name:file.name,contentBase64:await readBase64(file)}});await reload();count++;if(selected.size<5)selected.add(`s:${r.source.id}`);else unselected++;
          }catch(e){failures.push(`${file.name}：${e.message}`);}
        }
        await onTaskChange();if(failures.length)throw new Error(`已保存 ${count} 份资料。${failures.join('；')}`);toast(`已保存 ${count} 份资料${unselected?`，${unselected} 份未勾选（最多 5 份）`:''}`);
      });return;
    }
    if(target.id==='tw-template-file'){
      const file=target.files?.[0];if(!file)return;
      await run(async()=>{if(!/\.(docx|txt|md|csv)$/i.test(file.name)||!file.size||file.size>1048576)throw new Error('请使用不超过 1 兆的 .docx、.txt、.md 或 .csv 模板。');status('正在本机读取模板…');const r=await post('/api/ai/import',{file:{name:file.name,contentBase64:await readBase64(file)}});customTemplate={name:(r.title||file.name).slice(0,100),content:r.content};resetConsent();},'模板已读取，仅用于本次文档');return;
    }
    if(name==='sourceKeys'){
      if(target.checked&&selected.size>=5){target.checked=false;toast('每次最多选择 5 份素材',true);return;}
      if(target.checked)selected.add(target.value);else selected.delete(target.value);resetConsent();const count=document.querySelector('#tw-source-count');if(count)count.textContent=`已选 ${selected.size} / 5`;return;
    }
    if(name==='templateId'){if(target.value==='__custom')return;templateId=target.value;customTemplate=null;resetConsent();rerender();return;}
    if(name==='generateConsent'){consent=target.checked;consentRevision=consent?workspace.settings.configRevision:'';}
    if(name==='finishConfirmed')confirmed=target.checked;
    if(name==='documentId'){await run(()=>openDocument(target.value));}
  }
  return {open,render,onAction,onSubmit,input,change,reload:async()=>{if(!workspace||busy)return;await reload();rerender();},get busy(){return busy;},get taskId(){return id;},get hasUnsaved(){return [...editors.values()].some(dirty)||!!materialEditor?.dirty||[...taskDrafts].some(([key,value])=>key!==id&&([...value.editors.values()].some(dirty)||value.materialEditor?.dirty));}};
}
