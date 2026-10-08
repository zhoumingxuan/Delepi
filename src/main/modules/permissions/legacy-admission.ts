import type { PermissionPolicy } from '../../../shared/types/autonomy';
import type { LegacyToolGroup } from './legacy-policy';

let policyReader: (()=>PermissionPolicy)|undefined;
/** Installed once by the main process after migration, before any execution IPC. */
export function setLegacyPolicyReader(reader:()=>PermissionPolicy):void {policyReader=reader;}
export function legacyToolAllowed(toolName:string,dynamic:boolean,mode?:'trusted'|'public'):boolean {
  if(mode==='public')return false;
  if(!policyReader)return true; // Compatibility-only fixtures; production always installs before IPC.
  try {
    const denied=policyReader().deniedLegacyTools;
    const groups:LegacyToolGroup[]=dynamic?['dynamicTools','localFiles']:
      toolName==='run_shell'?['shell','localFiles']:toolName==='run_with_python'?['python','localFiles']:
      toolName==='use_script_tool'?['scriptTools','localFiles']:['localFiles'];
    return !groups.some(group=>denied.includes(group));
  } catch{return false;}
}
