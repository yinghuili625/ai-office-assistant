import {createModelSettings} from './ai-settings.js';
import {modelService,runAiJob} from './ai-service-info.js';

// AI 文档工作区。模型调用必须来自明确的用户操作。
export function createAiOffice(ui) {
  const {api,esc,icon,action,option,heading,empty,timeText,openDrawer,closeDrawer,toast,getTasks,rerender}=ui;
  let state={settings:{enabled:false,baseUrl:'http://localhost:11434/v1',model:'',transcriptionModel:'',keyConfigured:false},templates:[],materials:[],documents:[],metrics:{reviewedCount:0,usableCount:0,usableRate:null}};
  let loaded=false,loadError='',loading=null,busy=false,tab='documents',editor=null,displayedRevision='',taskChoices=[],taskSearchTimer=null,taskSearchToken=0;
  const urlId=id=>encodeURIComponent(id);
  const endpoint=()=>state.settings.baseUrl||'http://localhost:11434/v1';
  const service=()=>{try{return new URL(endpoint()).host;}catch{return endpoint();}};
  const allTaskChoices=()=>[...new Map([...taskChoices,...getTasks(),...state.materials.filter(m=>m.taskId&&m.taskTitle).map(m=>({id:m.taskId,title:m.taskTitle})),...state.documents.filter(d=>d.taskId&&d.taskTitle).map(d=>({id:d.taskId,title:d.taskTitle}))].map(t=>[t.id,t])).values()];
  const taskName=id=>allTaskChoices().find(t=>t.id===id)?.title||(id?'关联任务已删除':'未关联任务');
  const taskOptions=(tasks,selected)=>option('',selected,'不关联任务')+tasks.map(t=>option(t.id,selected,`${t.number?`第 ${t.number} 号 · `:''}${t.title}`)).join('');
  const button=(name,label,cls='button',extra='')=>action(`ai-${name}`,label,cls,extra);
  const cancel=()=>action('close','关闭','button');
  const errorBox='<div class="form-error" role="alert"></div>';
  const textField=(label,name,value='',extra='')=>`<div class="field"><label for="ai-${name}">${label}</label><input id="ai-${name}" name="${name}" value="${esc(value)}" ${extra}></div>`;
  const textArea=(label,name,value='',extra='')=>`<div class="field"><label for="ai-${name}">${label}</label><textarea id="ai-${name}" name="${name}" ${extra}>${esc(value)}</textarea></div>`;
  const taskSelect=(selected='')=>`<div class="field"><label for="ai-task-search">搜索关联任务（选填）</label><input id="ai-task-search" placeholder="按任务名称或编号搜索" autocomplete="off"><select id="ai-taskId" name="taskId" aria-label="关联任务">${taskOptions(allTaskChoices(),selected)}</select><span class="hint">默认列出最近 100 项，搜索可查找更早任务。仅用于本机索引，任务信息及交付文件不会自动发送给模型。</span></div>`;
  const submit=(id,label,extra='')=>`<button type="submit" form="${id}" class="button primary" ${extra}>${label}</button>`;
  const post=(path,body,method='POST')=>api(path,{method,body:JSON.stringify(body.consent===true?{...body,configRevision:body.configRevision??displayedRevision}:body)});
  const ready=()=>state.settings.enabled&&state.settings.model&&!state.settings.configError;
  const modelSettings=createModelSettings({esc,openDrawer,action,request,rerender,getSettings:()=>state.settings,saveSettings:async payload=>{
    const result=await post('/api/ai/settings',payload,'PATCH');state.settings=result.settings;return result;
  },testConnection:(target='text')=>post('/api/ai/test',{consent:true,target,configRevision:state.settings.configRevision})});

  async function load(render=true) {
    if(loading)return loading;
    loading=(async()=>{
      try{const [next,choices]=await Promise.all([api('/api/ai'),api('/api/tasks/options')]);state=next;taskChoices=choices.tasks;loaded=true;loadError='';return true;}
      catch(error){loadError=error.message;return false;}
      finally{loading=null;if(render)rerender();}
    })();
    return loading;
  }
  function showError(error,form=document.querySelector('.drawer form')) {
    if(error.partialText&&form?.id==='ai-material-form')preserveTranscription(form,error.partialText,'完整转写未成功。下面是已完成段落，可复制整理到素材正文；重新转写会再次发送录音。');
    const el=form?.querySelector('.form-error');
    if(el){el.textContent=error.message;el.scrollIntoView({block:'nearest'});}else toast(error.message,true);
  }
  function preserveTranscription(form,text,hint){
    let pending=form.querySelector('#ai-transcription-pending');
    if(!pending){pending=document.createElement('div');pending.id='ai-transcription-pending';pending.className='field';pending.innerHTML='<label for="ai-transcription-result">已完成的转写正文</label><textarea id="ai-transcription-result" rows="10" readonly></textarea><span class="hint"></span>';form.querySelector('.ai-audio .ai-form-stack').append(pending);}
    pending.querySelector('textarea').value=text;pending.querySelector('.hint').textContent=hint;
  }
  async function request(form,label,fn,trigger=null) {
    if(busy)return null;
    const err=form?.querySelector('.form-error');if(err)err.textContent='';
    const controls=[...document.querySelectorAll('.drawer button,.drawer input,.drawer select,.drawer textarea')];
    const prior=controls.map(el=>el.disabled);
    const submitter=trigger||(form?document.querySelector(`button[form="${form.id}"][type="submit"]`)||form.querySelector('[type="submit"]'):null);
    const oldText=submitter?.textContent;
    busy=true;controls.forEach(el=>el.disabled=true);
    document.querySelector('.drawer')?.setAttribute('aria-busy','true');
    if(submitter)submitter.textContent=label;
    try{return {value:await fn()};}
    catch(error){showError(error,form);return null;}
    finally{
      busy=false;controls.forEach((el,i)=>el.disabled=prior[i]);
      if(submitter)submitter.textContent=oldText;
      document.querySelector('.drawer')?.removeAttribute('aria-busy');
      if(editor&&document.querySelector('#ai-document-form'))updateEditorControls();
    }
  }
  function render() {
    const s=state.settings,m=state.metrics;
    const buttons=`${button('settings','模型设置')}${button('generate',`${icon('plus')} 起草文档`,'button primary')}`;
    const status=s.configError?'配置异常':s.enabled&&s.model?'已启用':s.model?'未启用':'尚未配置';
    const intro=`${heading('AI 文档','整理素材、起草文档，人工确认后导出。',buttons)}<div class="ai-summary"><div><span class="badge ${ready()?'done':'todo'}">${esc(status)}</span><span class="ai-service">模型服务：${esc(service())}${s.model?` · ${esc(s.model)}`:''}</span></div><div class="ai-quality">初稿可用率 <strong>${m.usableRate===null||m.usableRate===undefined?'暂无评价':`${Math.round(Number(m.usableRate)*100)}%`}</strong><span>已评价 ${Number(m.reviewedCount)||0} 份 · 可用 ${Number(m.usableCount)||0} 份</span></div></div>`;
    if(!loaded&&!loadError)return `${intro}<section class="panel"><div class="skeleton">正在读取文档工作区…</div></section>`;
    const tabs=`<div class="tabs ai-tabs" role="tablist" aria-label="文档工作区">${[['documents','文档',state.documents.length],['materials','素材与样例',state.materials.length],['templates','文档模板',state.templates.length]].map(([key,label,count])=>button('tab',`${label}<span class="tab-count">${count}</span>`,`tab ${tab===key?'active':''}`,`data-tab="${key}" role="tab" aria-selected="${tab===key}"`)).join('')}</div>`;
    return `${intro}${loadError?`<div class="error-banner">${esc(loadError)} ${button('reload','重新读取','button small')}</div>`:''}${s.configError?`<div class="error-banner">${esc(s.configError)}</div>`:''}<section class="panel">${tabs}${tab==='materials'?materialsList():tab==='templates'?templatesList():documentsList()}</section><p class="ai-footnote">只会发送你本次选中的素材、历史样例和文档模板。AI 初稿需要核对，历史样例仅供格式参考。</p>`;
  }
  function documentsList() {
    if(!state.documents.length)return empty('还没有起草文档','先保存素材，再选择模板起草第一份文档。');
    return `<div class="ai-list">${state.documents.map(d=>`<article class="ai-list-item"><div class="ai-list-copy"><h3>${button('document',esc(d.title),'ai-title',`data-id="${esc(d.id)}"`)}</h3><p>${esc(d.templateName)} · ${esc(taskName(d.taskId))}</p><p>更新于 ${timeText(d.updatedAt)} · 第 ${Number(d.revision)} 版${d.reviewedAt?` · ${esc(d.reviewer||'管理员')} 已确认`:''}</p></div><div class="ai-list-actions"><span class="badge ${d.status==='已确认'?'done':'todo'}">${esc(d.status)}</span>${button('document','打开','button small',`data-id="${esc(d.id)}"`)}</div></article>`).join('')}</div>`;
  }
  function materialsList() {
    return `<div class="panel-heading"><h2>本机资料库</h2>${button('material-new',`${icon('plus')} 添加素材`,'button small')}</div>${state.materials.length?`<div class="ai-list">${state.materials.map(m=>`<article class="ai-list-item"><div class="ai-list-copy"><h3>${button('material',esc(m.title),'ai-title',`data-id="${esc(m.id)}"`)}</h3><p>${esc(m.kind)} · ${esc(taskName(m.taskId))}</p><p>更新于 ${timeText(m.updatedAt||m.createdAt)}</p></div><div class="ai-list-actions">${button('material','编辑','button small',`data-id="${esc(m.id)}"`)}${button('material-delete-prompt','删除','button small ghost danger',`data-id="${esc(m.id)}"`)}</div></article>`).join('')}</div>`:empty('素材库为空','可粘贴正文、从文件导入或将录音转写为素材；历史样例单独标记。')}`;
  }
  function templatesList() {
    return `<div class="panel-heading"><h2>起草结构与写作要求</h2>${button('template-new',`${icon('plus')} 新建文档模板`,'button small')}</div><div class="ai-list">${state.templates.map(t=>`<article class="ai-list-item"><div class="ai-list-copy"><h3>${esc(t.name)}</h3><p class="ai-template-preview">${esc(t.content)}</p></div>${button('template','编辑模板','button small',`data-id="${esc(t.id)}"`)}</article>`).join('')}</div>`;
  }
  function settingsForm() {
    modelSettings.open();
  }
  function testForm() {
    displayedRevision=state.settings.configRevision;
    openDrawer('测试模型连接',`<form id="ai-test-form">${errorBox}<div class="ai-form-stack"><p class="ai-note">将向 <strong>${esc(endpoint())}</strong> 的 <strong>${esc(state.settings.model||'未配置')}</strong> 模型发送一段固定虚构文字，请确认后测试。</p><p class="subtitle">测试不读取任务、素材或文档。第三方服务可能按请求计费。</p><label class="ai-check"><input name="consent" type="checkbox" required><span>我同意向上述模型服务发送固定虚构测试文字</span></label></div></form>`,`${action('close','取消','button')}${submit('ai-test-form','确认测试连接')}`);
  }
  function materialForm(m={}) {
    displayedRevision=state.settings.configRevision;
    const s=state.settings,audio=modelService(s,'transcription');
    editor=null;
    openDrawer(m.id?'编辑素材':'添加素材',`<form id="ai-material-form" data-id="${esc(m.id||'')}">${errorBox}<div class="ai-form-stack">${textField('资料名称','title',m.title,'required maxlength="200"')}<div class="form-grid"><div class="field"><label for="ai-kind">资料类型</label><select id="ai-kind" name="kind">${['素材','历史样例'].map(v=>option(v,m.kind||'素材')).join('')}</select><span class="hint">历史样例仅供格式参考，不应当作本次事实。</span></div>${taskSelect(m.taskId)}</div><div class="ai-import"><label for="ai-material-file">从文件导入正文</label><input id="ai-material-file" type="file" accept=".txt,.md,.csv,.docx"><p>支持文本、Markdown、表格文本和 Word，文件不超过 1 兆。仅在本机提取，选择文件后会替换下方正文。</p></div>${textArea('素材正文','content',m.content,'required maxlength="60000" rows="12" placeholder="粘贴会议记录、事实数据或历史样例正文"')}<details class="ai-audio"><summary>录音转写为素材（选用）</summary><div class="ai-form-stack"><p>转写服务：<strong>${esc(audio.baseUrl)}</strong><br>转写模型：${esc(audio.model||'尚未配置，请先在模型设置中填写')}</p><input id="ai-audio-file" type="file" accept=".mp3,.wav,.m4a,.webm,.mp4,.ogg,.flac" aria-label="选择录音文件"><p class="hint">千问支持最大 100 兆、最长 4 小时的录音，本机分成短段后逐段转写；其他兼容接口最大 20 兆。录音会发往上述服务，核对转写结果后保存素材。</p><label class="ai-check"><input id="ai-audio-consent" type="checkbox"><span>我同意将所选录音发送给上述服务进行转写</span></label>${button('transcribe','开始转写','button small',`${!s.transcriptionModel||!s.enabled?'disabled':''}`)}</div></details></div></form>`,`${action('close','取消','button')}${submit('ai-material-form','保存素材')}`);
  }
  function templateForm(t={}) {
    displayedRevision=state.settings.configRevision;
    editor=null;
    openDrawer(t.id?'编辑文档模板':'新建文档模板',`<form id="ai-template-form" data-id="${esc(t.id||'')}">${errorBox}<div class="ai-form-stack"><details class="ai-template-assist"><summary>从历史文档识别（选用）</summary><div class="ai-form-stack"><p class="hint">提交一份历史文档，自动整理章节结构、下次写作需要补充的信息和写作要求。识别结果由你确认后再应用。</p><div class="ai-import"><label for="ai-template-file">选择历史文档</label><input id="ai-template-file" type="file" accept=".txt,.md,.csv,.docx"><p>支持 Word（.docx）、文本、Markdown 和表格文本，文件不超过 1 兆。仅在本机提取，选择文件后替换下方历史正文；也可直接粘贴。</p></div>${textField('历史文档名称（选填）','historyTitle','','maxlength="200" placeholder="例如：上月培训总结"')}${textArea('历史文档正文','historyContent','','maxlength="20000" rows="8" placeholder="导入文件或在这里粘贴正文，发送前请核对内容，最多 20000 字。"')}<div class="ai-note">发送至：<strong>${esc(endpoint())}</strong><br>使用模型：<strong>${esc(state.settings.model||'尚未配置')}</strong><br>仅发送此处的历史文档名称与正文，用于识别模板；不会自动保存历史文档。</div>${!ready()?'<p class="hint">请先关闭此窗口，在「模型设置」中配置并启用文档模型，再使用识别功能。也可直接填写下方模板。</p>':''}<label class="ai-check"><input id="ai-template-consent" type="checkbox"><span>我已核对历史正文，同意发送给上述模型服务识别结构与待补充内容</span></label><div>${button('template-analyze','识别结构与待补充内容','button small',!ready()?'disabled':'')}</div><section id="ai-template-suggestion" class="ai-template-suggestion" hidden><div class="ai-form-stack"><p class="ai-note">识别完成。请检查建议是否准确；点击「应用到模板」会替换下方模板名称与结构内容，仍需保存模板才会生效。</p>${textField('建议模板名称','suggestionName','','readonly')}${textArea('建议结构、待补充内容与写作要求','suggestionContent','','readonly rows="10"')}<div>${button('template-apply','应用到模板','button small primary')}</div></div></section></div></details>${textField('模板名称','name',t.name,'required maxlength="100" placeholder="例如：培训总结、工作汇报"')}${textArea('结构与写作要求','content',t.content,'required maxlength="20000" rows="15" placeholder="填写章节结构、语气与内容要求。不要在模板中写入本次未经核对的事实。"')}<p class="hint">本次生成使用的模板会随文档保存，后续修改模板不影响历史文档。</p></div></form>`,`${action('close','取消','button')}${submit('ai-template-form','保存模板')}`);
  }
  function clearTemplateSuggestion(form) {
    if(!form)return;
    form.querySelector('#ai-template-consent').checked=false;
    form.querySelector('#ai-template-suggestion').hidden=true;
    form.elements.suggestionName.value='';form.elements.suggestionContent.value='';
  }
  async function analyzeTemplate(trigger) {
    const form=document.querySelector('#ai-template-form');if(!form)return;
    try{
      if(!ready())throw new Error('请先在「模型设置」中配置并启用文档模型。');
      const title=form.elements.historyTitle.value.trim()||'历史文档',content=form.elements.historyContent.value.trim();
      if(!content)throw new Error('请先导入历史文档或粘贴历史正文。');
      if(content.length>20000)throw new Error('历史正文不能超过 60000 字，请整理后重试。');
      if(!form.querySelector('#ai-template-consent').checked)throw new Error('请先核对历史正文，并勾选同意发送给上述模型服务。');
      const result=await request(form,'正在识别，请稍候…',()=>post('/api/ai/templates/analyze',{title,content,consent:true}),trigger);
      if(result){
        const suggestion=result.value.suggestion;
        if(!suggestion||typeof suggestion.name!=='string'||!suggestion.name.trim()||suggestion.name.length>100||typeof suggestion.content!=='string'||!suggestion.content.trim()||suggestion.content.length>20000)throw new Error('识别结果不完整，请重试；历史正文和已填写模板已保留。');
        form.elements.suggestionName.value=suggestion.name;form.elements.suggestionContent.value=suggestion.content;
        const preview=form.querySelector('#ai-template-suggestion');preview.hidden=false;preview.scrollIntoView({block:'nearest'});
        toast('识别完成，请检查建议后应用到模板');
      }
    }catch(error){showError(error,form);}
  }
  function applyTemplateSuggestion() {
    const form=document.querySelector('#ai-template-form');if(!form)return;
    if(!form.elements.suggestionContent.value.trim())return;
    form.elements.name.value=form.elements.suggestionName.value;
    form.elements.content.value=form.elements.suggestionContent.value;
    form.elements.name.scrollIntoView({block:'nearest'});form.elements.name.focus({preventScroll:true});
    toast('已应用到下方模板，可继续编辑，核对后点击「保存模板」');
  }
  function generateForm(taskId='') {
    displayedRevision=state.settings.configRevision;
    editor=null;
    const task=allTaskChoices().find(t=>t.id===taskId);
    const materials=state.materials.filter(m=>m.kind==='素材'),references=state.materials.filter(m=>m.kind==='历史样例');
    const choices=(items,name)=>items.map(m=>`<label class="ai-choice"><input name="${name}" value="${esc(m.id)}" type="checkbox"><span><strong>${esc(m.title)}</strong><small>${esc(taskName(m.taskId))}</small></span></label>`).join('');
    openDrawer('AI 起草文档',`<form id="ai-generate-form">${errorBox}<div class="ai-form-stack">${!ready()?`<div class="ai-note">尚未启用可用的文档模型。请先关闭此窗口，在「模型设置」中保存配置。</div>`:''}${textField('文档名称','title',task?.title||'','required maxlength="200"')}${taskSelect(taskId)}<div class="field"><label for="ai-templateId">文档模板</label><select id="ai-templateId" name="templateId" required><option value="">请选择模板</option>${state.templates.map(t=>option(t.id,'',t.name)).join('')}</select></div><fieldset class="ai-fieldset"><legend>本次素材（至少 1 份，最多 5 份）</legend><div class="ai-choices">${materials.length?choices(materials,'materialIds'):'<p class="subtitle">尚无素材，请先在「素材与样例」中添加。</p>'}</div></fieldset><fieldset class="ai-fieldset"><legend>历史样例（选填，最多 3 份）</legend><p class="hint">仅参考结构和表达，不应把历史事实写入本次文档。</p><div class="ai-choices">${references.length?choices(references,'referenceIds'):'<p class="subtitle">暂无历史样例。</p>'}</div></fieldset><div class="ai-note">发送至：<strong>${esc(endpoint())}</strong><br>使用模型：<strong>${esc(state.settings.model||'尚未配置')}</strong><br>仅发送上述所选正文和模板；关联任务信息及交付文件不自动发送。AI 输出为待审核初稿。</div><label class="ai-check"><input name="consent" type="checkbox" required><span>我已核对所选资料，并同意发送给上述模型服务起草</span></label></div></form>`,`${action('close','取消','button')}${submit('ai-generate-form','确认发送并起草',!ready()?'disabled':'')}`);
  }
  function documentForm(d) {
    editor={id:d.id,revision:d.revision,title:d.title,content:d.content,status:d.status,dirty:false};
    const sources=Array.isArray(d.sources)?d.sources:[];
    const reviews=Array.isArray(d.reviews)?d.reviews:[];
    openDrawer('编辑与审核文档',`<div class="ai-document-status"><span class="badge ${d.status==='已确认'?'done':'todo'}">${esc(d.status)}</span><span>第 ${Number(d.revision)} 版 · ${esc(d.templateSnapshot?.name||d.templateName||'文档模板')}</span></div><form id="ai-document-form" data-id="${esc(d.id)}">${errorBox}<div class="ai-form-stack">${textField('文档名称','title',d.title,'required maxlength="200"')}${textArea('文档正文','content',d.content,'required maxlength="60000" rows="18"')}<p id="ai-dirty-hint" class="ai-edit-hint" role="status">内容修改后请先保存，再重新人工确认。</p></div></form><section class="ai-review"><h3>人工核对与初稿评价</h3><p id="ai-review-hint">请核对人名、数字、日期、结论以及与所选素材的一致性。初稿评价用于统计 AI 最初生成内容的可用程度。</p><form id="ai-review-form">${errorBox}<div class="ai-form-stack"><div class="field"><label for="ai-quality">AI 原始初稿质量</label><select id="ai-quality" name="quality" required><option value="">请选择评价</option>${['可用','需修改','不可用'].map(v=>option(v,'')).join('')}</select></div>${textArea('审核意见','reviewNote','','required maxlength="5000" rows="3" placeholder="填写核对情况、修改内容或发现的问题"')}<label class="ai-check"><input name="confirmed" type="checkbox" required><span>我已完成人工核对，确认当前保存版本可作为成稿使用</span></label><div>${submit('ai-review-form','确认当前版本')}</div></div></form></section><div class="ai-export"><h3>成稿导出</h3><p id="ai-export-hint">${d.status==='已确认'?'当前版本已确认，可以导出。':'待审核文档需先人工确认，才能导出。'}</p><div class="button-row">${button('export',`${icon('download')} 导出 Word`,'button small',`data-id="${esc(d.id)}" data-format="docx" ${d.status!=='已确认'?'disabled':''}`)}${button('export',`${icon('download')} 导出 Markdown`,'button small',`data-id="${esc(d.id)}" data-format="md" ${d.status!=='已确认'?'disabled':''}`)}</div></div><details class="ai-history"><summary>本次来源与模板</summary><p>以下资料已随初稿固化保存；历史样例只供格式参考。</p>${sources.map(s=>`<details><summary>${esc(s.kind||'素材')} · ${esc(s.title||'未命名资料')}</summary><pre>${esc(s.content||'')}</pre></details>`).join('')}<details><summary>文档模板</summary><pre>${esc(d.templateSnapshot?.content||'')}</pre></details></details><details class="ai-history"><summary>原始初稿与审核记录（${reviews.length} 条）</summary><details><summary>AI 原始初稿</summary><pre>${esc(d.originalContent||'')}</pre></details>${reviews.map(r=>`<article><p>${esc(r.reviewer||'管理员')} · 第 ${Number(r.revision)} 版 · ${timeText(r.reviewedAt||r.createdAt)}</p><p>初稿评价：${esc(r.quality)}</p><pre>${esc(r.reviewNote||'')}</pre></article>`).join('')}</details>`,`${cancel()}${submit('ai-document-form','保存修改')}`);
    updateEditorControls();
  }
  function updateEditorControls() {
    if(!editor)return;
    const form=document.querySelector('#ai-document-form');if(!form)return;
    editor.dirty=form.elements.title.value!==editor.title||form.elements.content.value!==editor.content;
    const hint=document.querySelector('#ai-dirty-hint');
    hint.textContent=editor.dirty?'有未保存修改。保存后当前确认将作废，需要重新人工审核。':'当前内容已保存。修改后需重新人工确认。';
    document.querySelectorAll('button[form="ai-review-form"],#ai-review-form input,#ai-review-form select,#ai-review-form textarea').forEach(el=>el.disabled=busy||editor.dirty||editor.status==='已确认');
    document.querySelector('#ai-review-hint').textContent=editor.status==='已确认'&&!editor.dirty?'当前版本已确认，修改保存后可重新审核。':editor.dirty?'请先保存文档修改，再核对确认新版本。':'请核对人名、数字、日期、结论以及与所选素材的一致性。初稿评价用于统计 AI 最初生成内容的可用程度。';
    document.querySelectorAll('[data-action="ai-export"]').forEach(el=>el.disabled=busy||editor.dirty||editor.status!=='已确认');
    document.querySelector('#ai-export-hint').textContent=editor.dirty?'请先保存修改，再重新确认后导出。':editor.status==='已确认'?'当前版本已确认，可以导出。':'待审核文档需先人工确认，才能导出。';
  }
  async function ensureLoaded() {
    if(!loaded&&!await load(false))throw new Error(loadError||'暂时无法读取文档工作区');
  }
  async function onAction(name,el) {
    if(busy)return;
    try{
      await ensureLoaded();
      const id=el?.dataset.id;
      if(name==='tab'){tab=el.dataset.tab;rerender();}
      if(name==='reload')await load();
      if(name==='settings')settingsForm();
      if(name==='test')testForm();
      if(name==='material-new')materialForm();
      if(name==='material'){const result=await request(null,'正在读取…',()=>api(`/api/ai/materials/${urlId(id)}`));if(result)materialForm(result.value.material);}
      if(name==='material-delete-prompt'){
        const m=state.materials.find(m=>m.id===id);if(!m)throw new Error('资料不存在，请刷新后重试');
        openDrawer('删除资料',`<form id="ai-material-delete-form" data-id="${esc(id)}">${errorBox}<p class="delete-task-name">${esc(m.title)}</p><p class="subtitle">资料将从可选列表中移除，已生成文档中保存的来源快照仍会保留。</p></form>`,`${action('close','取消','button')}<button type="submit" form="ai-material-delete-form" class="button danger">确认删除</button>`);
      }
      if(name==='template-new')templateForm();
      if(name==='template')templateForm(state.templates.find(t=>t.id===id));
      if(name==='template-analyze')await analyzeTemplate(el);
      if(name==='template-apply')applyTemplateSuggestion();
      if(name==='generate')generateForm(el?.dataset.taskId||'');
      if(name==='document'){const result=await request(null,'正在读取…',()=>api(`/api/ai/documents/${urlId(id)}`));if(result)documentForm(result.value.document);}
      if(name==='transcribe')await transcribe();
      if(name==='export')await exportFile(id,el.dataset.format,el);
    }catch(error){showError(error);}
  }
  async function onSubmit(form) {
    const fields=Object.fromEntries(new FormData(form));
    try{
      if(form.id==='ai-settings-form'){
        await modelSettings.submit(form);
      }
      if(form.id==='ai-test-form'){
        if(!form.elements.consent.checked)throw new Error('请先勾选同意发送固定虚构测试文字。');
        const result=await request(form,'正在测试…',()=>post('/api/ai/test',{consent:true}));
        if(result){closeDrawer();toast(result.value.message||'模型连接成功');}
      }
      if(form.id==='ai-material-form'){
        const id=form.dataset.id;
        const result=await request(form,'正在保存…',()=>post(id?`/api/ai/materials/${urlId(id)}`:'/api/ai/materials',{title:fields.title,kind:fields.kind,content:fields.content,taskId:fields.taskId||null},id?'PATCH':'POST'));
        if(result){tab='materials';await load(false);closeDrawer();rerender();toast('素材已保存到本机');}
      }
      if(form.id==='ai-material-delete-form'){
        const result=await request(form,'正在删除…',()=>post(`/api/ai/materials/${urlId(form.dataset.id)}`,{},'DELETE'));
        if(result){await load(false);closeDrawer();rerender();toast('资料已从列表中移除');}
      }
      if(form.id==='ai-template-form'){
        const id=form.dataset.id;
        const result=await request(form,'正在保存…',()=>post(id?`/api/ai/templates/${urlId(id)}`:'/api/ai/templates',{name:fields.name,content:fields.content},id?'PATCH':'POST'));
        if(result){tab='templates';await load(false);closeDrawer();rerender();toast('文档模板已保存');}
      }
      if(form.id==='ai-generate-form'){
        const fd=new FormData(form),materialIds=fd.getAll('materialIds'),referenceIds=fd.getAll('referenceIds');
        if(!materialIds.length||materialIds.length>5)throw new Error('请选择 1 至 5 份本次素材。');
        if(referenceIds.length>3)throw new Error('历史样例最多选择 3 份。');
        if(!form.elements.consent.checked)throw new Error('请先确认所选资料和发送目的地。');
        const result=await request(form,'正在起草，请稍候…',()=>post('/api/ai/documents',{title:fields.title,templateId:fields.templateId,taskId:fields.taskId||null,materialIds,referenceIds,consent:true}));
        if(result){tab='documents';await load(false);rerender();documentForm(result.value.document);toast('AI 初稿已保存，请完成人工核对');}
      }
      if(form.id==='ai-document-form'){
        if(!editor)throw new Error('文档版本信息丢失，请关闭后重新打开。');
        if(!editor.dirty){toast('当前内容没有修改');return;}
        const result=await request(form,'正在保存…',()=>post(`/api/ai/documents/${urlId(editor.id)}`,{title:fields.title,content:fields.content,revision:editor.revision},'PATCH'));
        if(result){await load(false);rerender();documentForm(result.value.document);toast('修改已保存，请重新人工确认');}
      }
      if(form.id==='ai-review-form'){
        if(!editor||editor.dirty)throw new Error('请先保存文档修改，再进行人工确认。');
        if(!form.elements.confirmed.checked)throw new Error('请先完成人工核对并勾选确认。');
        const result=await request(form,'正在确认…',()=>post(`/api/ai/documents/${urlId(editor.id)}/review`,{revision:editor.revision,confirmed:true,reviewNote:fields.reviewNote,quality:fields.quality}));
        if(result){await load(false);rerender();documentForm(result.value.document);toast('当前版本已确认，可以导出成稿');}
      }
    }catch(error){showError(error,form);}
  }
  async function importMaterial(input) {
    const file=input.files?.[0];if(!file)return;
    const form=document.querySelector('#ai-material-form');
    try{
      if(file.size>1024*1024||!file.size)throw new Error('请选择非空且不超过 1 兆的文件。');
      if(!/\.(txt|md|csv|docx)$/i.test(file.name))throw new Error('支持文本、Markdown、CSV 和 Word 文件。');
      const result=await request(form,'正在提取正文…',async()=>post('/api/ai/import',{file:{name:file.name,contentBase64:await readBase64(file)}}));
      if(result){form.elements.content.value=result.value.content;if(!form.elements.title.value.trim())form.elements.title.value=result.value.title;toast('正文已在本机提取，请核对后保存素材');}
    }catch(error){showError(error,form);}finally{input.value='';}
  }
  async function importTemplateHistory(input) {
    const file=input.files?.[0];if(!file)return;
    const form=document.querySelector('#ai-template-form');if(!form)return;
    clearTemplateSuggestion(form);
    try{
      if(file.size>1024*1024||!file.size)throw new Error('请选择非空且不超过 1 兆的历史文档。');
      if(!/\.(txt|md|csv|docx)$/i.test(file.name))throw new Error('支持文本、Markdown、CSV 和 Word（.docx）文件。');
      const result=await request(form,'正在本机提取正文…',async()=>post('/api/ai/import',{file:{name:file.name,contentBase64:await readBase64(file)}}));
      if(result){form.elements.historyContent.value=result.value.content;form.elements.historyTitle.value=result.value.title;toast('历史正文已在本机提取，请核对后再识别');}
    }catch(error){showError(error,form);}finally{input.value='';}
  }
  async function transcribe() {
    const form=document.querySelector('#ai-material-form'),input=document.querySelector('#ai-audio-file');
    try{
      const file=input.files?.[0];if(!file)throw new Error('请先选择录音文件。');
      const max=modelService(state.settings,'transcription').provider==='qwen'?100:20;if(!file.size||file.size>max*1024*1024)throw new Error('录音文件必须非空，且不超过 '+max+' 兆。');
      if(!document.querySelector('#ai-audio-consent').checked)throw new Error('请先勾选同意将录音发送给模型服务。');
      const configRevision=displayedRevision;
      const result=await request(form,'正在转写，请稍候…',async()=>runAiJob(api,'/api/ai/transcribe-jobs',{file:{name:file.name,contentBase64:await readBase64(file)},consent:true,configRevision},message=>{const el=form.querySelector('.ai-audio .hint');if(el)el.textContent=message;}));
      if(result){
        const old=form.elements.content.value.trim(),text=result.value.text||'';
        if((old.length+text.length+(old?2:0))>60000){
          let pending=document.querySelector('#ai-transcription-pending');
          if(!pending){pending=document.createElement('div');pending.id='ai-transcription-pending';pending.className='field';pending.innerHTML='<label for="ai-transcription-result">已完成的转写正文</label><textarea id="ai-transcription-result" rows="10" readonly></textarea><span class="hint">与现有正文合并后超过 60000 字。请从这里复制需要的部分整理到素材正文，无需再次转写。</span>';document.querySelector('.ai-audio .ai-form-stack').append(pending);}
          pending.querySelector('textarea').value=text;pending.scrollIntoView({block:'nearest'});
          toast('转写已完成；合并超出字数限制，请从保留的结果中整理素材');
        }else{form.elements.content.value=old?`${old}\n\n${text}`:text;toast('转写已追加到正文，请核对后保存素材');}
        if(!form.elements.title.value.trim())form.elements.title.value=result.value.name||file.name;
        input.value='';document.querySelector('#ai-audio-consent').checked=false;
      }
    }catch(error){showError(error,form);}
  }
  function readBase64(file) {
    return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('读取文件失败，请重新选择。'));reader.readAsDataURL(file);});
  }
  async function exportFile(id,format,el) {
    if(!editor||editor.id!==id||editor.dirty||editor.status!=='已确认')throw new Error('请先保存并人工确认当前文档版本。');
    const title=editor.title;
    el.disabled=true;
    try{
      const response=await fetch(`/api/ai/documents/${urlId(id)}/export?format=${format==='docx'?'docx':'md'}`);
      if(!response.ok){const result=await response.json().catch(()=>({}));throw new Error(result.error||'导出失败，请稍后重试');}
      const blob=await response.blob(),url=URL.createObjectURL(blob),link=document.createElement('a');
      link.href=url;link.download=`${title.replace(/[\\/:*?"<>|]/g,'_')}.${format==='docx'?'docx':'md'}`;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
      toast('成稿已导出');
    }finally{el.disabled=false;}
  }
  return {load,render,onAction,onSubmit,get busy(){return busy;},input:target=>{
    if(target?.id==='ai-task-search'){
      const token=++taskSearchToken,selected=document.querySelector('#ai-taskId')?.value||'',q=target.value;
      clearTimeout(taskSearchTimer);taskSearchTimer=setTimeout(async()=>{try{const result=await api('/api/tasks/options?'+new URLSearchParams({q,selected}));const select=document.querySelector('#ai-taskId');if(token===taskSearchToken&&select&&document.querySelector('#ai-task-search')===target)select.innerHTML=taskOptions(result.tasks,selected);}catch(error){if(token===taskSearchToken)showError(error);}},200);
      return;
    }
    updateEditorControls();
    if(target?.id==='ai-historyTitle'||target?.id==='ai-historyContent')clearTemplateSuggestion(target.closest('#ai-template-form'));
  },change:async target=>{if(target.id==='ai-material-file')await importMaterial(target);if(target.id==='ai-template-file')await importTemplateHistory(target);}};
}
