'use strict';
const {fixture:explorationFixture}=require('../muse-m2-exploration/fixture.cjs');
const {loadSource}=require('../muse-m2-brokers/fixture.cjs');
let source;
async function fixture(t,options={}) {
  const api=await (source??=Promise.all(['src/main/db/migrations/learning-schema.ts','src/main/modules/learning/learning-service.ts'].map(loadSource))
    .then(values=>Object.assign({},...values)));
  let next=options.candidate??{};
  const f=await explorationFixture(t,{model:options.model,routes:{
    '/public':(_req,res)=>{res.writeHead(200,{'content-type':'text/plain'});res.end('Synthetic public evidence describing a review checklist.');},
    '/v1/chat/completions':(_req,res,request)=>{
      const body=JSON.parse(request.body),prompt=body.messages[0].content;
      const refs=Array.from(prompt.matchAll(/公开来源 ([A-Za-z0-9_-]+)，/g),match=>match[1]);
      const candidate={title:'公开资料比较方法',summary:'保存出处再核对多个证据。',applicability:'同一公开主题的资料比较。',
        steps:['核对发布日期。','记录事实与推断。'],checks:['每条结论有来源。'],limitations:['来源不全时明确不足。'],sourceRefs:refs,...next};
      const text=next===null?'本轮资料不足，无可复用方法。':'公开资料报告。\n\n<!-- delepi-skill-candidate:v1 -->\n```json\n'+JSON.stringify(candidate)+'\n```';
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:text},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:20}}));
    },
  }});
  f.db.exec(api.LEARNING_SCHEMA_SQL);
  let n=0;f.learning=api.createLearningService(f.db,{uuid:()=>`learning-fixture-${++n}`,...options.learning});
  f.learningApi=api;
  f.setUses=(uses=['learning.capture','skill.context'])=>f.db.prepare('UPDATE m2_data_scopes SET allowed_uses_json=? WHERE goal_id=?')
    .run(JSON.stringify(['fetch.public','file.read_public','model.invoke','artifact.publish',...uses]),f.goal.id);
  f.setUses();
  f.complete=async (candidate=next)=>{next=candidate;const run=f.start(f.plan());const stopApprove=f.approveAll();
    try{await f.exploration.waitForRun(run.runId);}finally{stopApprove();}
    const result=f.exploration.listExplorations().find(value=>value.runId===run.runId);
    if(result.state!=='completed')throw Error(JSON.stringify(result));return result;};
  return f;
}
module.exports={fixture};
