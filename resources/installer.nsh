; ============================================================================
; resources/installer.nsh - electron-builder 自定义 NSIS include（本项目 buildResources=resources）
;
; 本文件仅定义一个宏：customCheckAppRunning。当 electron-builder 26.15.3 模板
; include\allowOnlyOneInstallerInstance.nsh 的 CHECK_APP_RUNNING（L32-43）展开时，
; L37-38 检测到 customCheckAppRunning 已定义，即展开本宏以【替换】默认检测链
; （默认链 IS_POWERSHELL_AVAILABLE + _CHECK_APP_RUNNING，同文件 L40-41），达到治本效果：
;
;   (a) 精确按进程名检测：仅匹配 ${APP_EXECUTABLE_FILENAME}（本工程 = Delepi.exe），
;       完全忽略 $INSTDIR 前缀下的 python.exe 等非应用进程。模板默认 PowerShell 分支
;       （L66）按 Path.StartsWith('$INSTDIR') 前缀枚举全部进程且不校验进程名，是
;       "实际没有 Delepi 却被报正在运行 / 弹 重试-取消" 误报的根源；本宏不复用该分支。
;   (b) 命中后自动结束所有匹配进程（taskkill /F），随后循环检测等待进程退出
;       （每轮最多 5 次 x Sleep 1000，见阶段 3）；
;   (c) 超时仍存在时弹出【自定义中文提示】（不使用模板 $(appCannotBeClosed) 系统文案），
;       按钮语义 MB_RETRYCANCEL：重试 -> 再执行一轮"自动结束 + 等待退出"；
;       取消 / 静默场景（/SD IDCANCEL）-> Quit 中止安装或卸载；
;   (d) 未检测到 Delepi.exe 时静默直接放行，不弹任何提示（本次修复的放行核心路径）。
;
; 宏展开环境（任务约束 3 依据）：
;   * 本宏在 CHECK_APP_RUNNING 内展开时，$CmdPath / $PowerShellPath 已由模板
;     allowOnlyOneInstallerInstance.nsh L33-36 初始化为 $SYSDIR\cmd.exe 与
;     $SYSDIR\WindowsPowerShell\v1.0\powershell.exe；本宏仅使用 $CmdPath
;     （tasklist/taskkill 经 cmd 执行），不重复初始化、不新增与模板同义变量。
;   * 自定义宏存在时（allowOnlyOneInstallerInstance.nsh L5-8 守卫），模板不加载
;     getProcessInfo.nsh、不声明 Var pid；本宏不依赖 GetProcessInfo、不引用 $pid、
;     不使用 nsProcess 宏，因此无需自行 include 模板文件。
;   * 安装器/卸载器自身进程名（Setup*.exe / Uninstall Delepi.exe）恒不等于
;     ${APP_EXECUTABLE_FILENAME}，taskkill /IM 不会误杀安装进程自身，
;     故不引入模板 KILL_PROCESS 中 /FI "PID ne $pid" 的排除（该过滤依赖 Var pid）。
;
; 宏同时作用于（调用点证据，见 node_modules/app-builder-lib/templates/nsis）：
;   * 安装器 assisted 分支：installSection.nsh L36（条件 ${ifNot} ${UAC_IsInnerInstance}）；
;     oneClick 分支：installSection.nsh L33；
;   * 卸载器：uninstaller.nsh L2 Function un.checkAppRunning 内展开；该函数被
;     uninstaller.nsh L19（un.onInit silent）/ L26（oneClick 卸载，assisted 不编译）/
;     L150（assisted 卸载 Section "un.${UNINSTALL_SECTION_NAME}" 开始、非 silent）调用。
; ============================================================================
!macro customCheckAppRunning

  ; ============================================================
  ; 阶段 1：精确按名检测（仅匹配 ${APP_EXECUTABLE_FILENAME}）
  ; 说明：与模板 FIND_PROCESS 的 tasklist 精确分支（allowOnlyOneInstallerInstance.nsh
  ; L71 / L75）逐字同构（仅把宏参数 ${_FILE} 换成本工程进程名 ${APP_EXECUTABLE_FILENAME}）：
  ;   - tasklist 以 /FI "IMAGENAME eq <进程名>" 按【进程名】精确过滤（大小写不敏感）；
  ;   - findstr /B /I /C: 对 CSV 输出做【行首】精确锚定，杜绝子串误匹配；
  ;   - per-user 安装（本项目；INSTALL_MODE_PER_ALL_USERS 未定义时走 !else）额外以
  ;     /FI "USERNAME eq %USERNAME%" 限定当前用户，避免跨用户 Delepi.exe 实例被误报；
  ;   - 全程不使用 $INSTDIR 路径前缀枚举，python.exe 等 $INSTDIR 前缀下的非应用进程
  ;     不可能被命中（消除候选1/候选3 共用的误报根源）。
  ; nsExec::Exec 退出码（Pop $R0）：0 = 命中 Delepi.exe；非 0 = 未命中。
  ; ============================================================
  !ifdef INSTALL_MODE_PER_ALL_USERS
    nsExec::Exec `"$CmdPath" /C tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
  !else
    nsExec::Exec `"$CmdPath" /C tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
  !endif
  Pop $R0
  ${if} $R0 != 0
    ; (d) 未检测到 Delepi.exe -> 静默直接放行：跳到宏出口，不弹任何提示
    Goto car_no_app
  ${endIf}

  ; ============================================================
  ; 阶段 2 入口（每轮自动关闭起点；MessageBox "重试" 跳回此处）：
  ; 自动结束所有匹配进程（taskkill /F 强制结束）。
  ; 说明：与模板 KILL_PROCESS taskkill 分支同构（allowOnlyOneInstallerInstance.nsh
  ; L97 / L99 per-user 分支）；模板的 /FI "PID ne $pid" 依赖 Var pid（仅当本宏
  ; 未定义时模板 L7 才声明）与 GetProcessInfo 赋值，本宏按任务约束不依赖该模板文件，
  ; 因此不引用 $pid（原因见文件头注释：安装进程自身名恒不等于 Delepi.exe）。
  ; ============================================================
car_retry_round:
  !ifdef INSTALL_MODE_PER_ALL_USERS
    nsExec::Exec `taskkill /F /IM "${APP_EXECUTABLE_FILENAME}"`
  !else
    nsExec::Exec `"$CmdPath" /C taskkill /F /IM "${APP_EXECUTABLE_FILENAME}" /FI "USERNAME eq %USERNAME%"`
  !endif
  Pop $0                  ; 丢弃 taskkill 返回码（未找到进程时非 0 属正常）
  StrCpy $R1 0            ; 等待轮次计数归零（每轮最多等待 5 次 x Sleep 1000）

  ; ============================================================
  ; 阶段 3：循环检测等待进程退出（常量语义：最多 5 次 x Sleep 1000）
  ; 每轮：先递增计数，超过 5 次仍未退出 -> 进入阶段 4 兜底提示；
  ; 否则 Sleep 1000 后重新精确检测：已退出（返回码非 0）-> 放行出口；
  ; 仍在运行 -> 继续下一轮。
  ; ============================================================
car_wait_loop:
  IntOp $R1 $R1 + 1
  ${if} $R1 > 5
    Goto car_timeout      ; 约 5 秒后仍存在 -> 自定义中文兜底提示
  ${endIf}
  Sleep 1000
  !ifdef INSTALL_MODE_PER_ALL_USERS
    nsExec::Exec `"$CmdPath" /C tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
  !else
    nsExec::Exec `"$CmdPath" /C tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
  !endif
  Pop $R0
  ${if} $R0 != 0
    Goto car_no_app        ; 进程已退出 -> 放行
  ${endIf}
  Goto car_wait_loop

  ; ============================================================
  ; 阶段 4：超时兜底——自定义中文提示
  ; 不使用模板 $(appCannotBeClosed) 系统文案；按钮组合 MB_RETRYCANCEL：
  ;   IDRETRY car_retry_round -> 用户点"重试"：再执行一轮"自动结束 + 等待退出"；
  ;   /SD IDCANCEL -> 静默安装/卸载场景自动取"取消"（与模板 L156 语义一致）；
  ;   前台点"取消"同样落到下一行 Quit -> 中止安装/卸载。
  ; ============================================================
car_timeout:
  MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "检测到 ${PRODUCT_NAME} 正在运行且无法自动关闭，请手动关闭后重试。" /SD IDCANCEL IDRETRY car_retry_round
  Quit

  ; ============================================================
  ; 放行出口（宏正常结束 = 安装/卸载流程继续）：
  ;   1) 未检测到 Delepi.exe（阶段 1 直接放行，无任何提示）；
  ;   2) 自动结束后成功退出（阶段 3 放行）。
  ; ============================================================
car_no_app:
!macroend
