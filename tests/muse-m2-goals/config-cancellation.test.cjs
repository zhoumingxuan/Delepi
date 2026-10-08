'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {fixture}=require('../muse-m1-ui-config/fixture.cjs');
const {fixture:authorityFixture}=require('../muse-m2-permissions/fixture.cjs');
test('model destination notifications follow committed memory and never signal failed config transactions',async t=>{
  const f=await fixture(t);const manager=f.api.configManager;const calls=[];
  const unsubscribe=manager.onModelConfigurationChanged(()=>calls.push(manager.getSettings().mainModelName));
  f.db.exec("CREATE TRIGGER synthetic_refuse BEFORE INSERT ON settings WHEN NEW.key='mainModelName' BEGIN SELECT RAISE(ABORT,'synthetic configuration failure'); END;");
  assert.throws(()=>manager.commitSettings({mainModelName:'failed'}));assert.equal(calls.length,0);
  f.db.exec('DROP TRIGGER synthetic_refuse');manager.commitSettings({mainModelName:'committed'});assert.deepEqual(calls,['committed']);
  manager.commitSettings({mainThinkingLevel:''});assert.equal(calls.length,1);
  unsubscribe();manager.commitSettings({mainModelName:'later'});assert.equal(calls.length,1);
});
test('configuration cancellation aborts current leases without DB reads and invalidates pending waits at policy safe point',async t=>{
  const f=await authorityFixture(t);f.authorize('run');const prepared=f.authority.prepare(f.context,f.action);
  const second=f.taskService.beginAttempt(f.context,{taskId:'other',delegateCallId:'other'});
  const preview=f.authority.previewAction(second,{...f.action,summary:'other actual bounded action'},1);
  const wait=f.authority.waitForDecision(preview.id);const rejected=assert.rejects(wait,/POLICY_BLOCKED|APPROVAL_CHANGED/);
  f.authority.cancelAllPublicOperations();assert.equal(prepared.signal.aborted,true);
  f.authority.updatePolicy(1,{deniedCapabilities:['fetch.public'],deniedLegacyTools:[]});await rejected;
});
