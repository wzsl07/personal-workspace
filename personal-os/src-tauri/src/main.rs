// 桌面壳：把同一套前端塞进系统窗口，补上浏览器给不了的三件事
//   1. 系统级全局悬浮球（独立置顶小窗）
//   2. 全局快捷键（默认 Alt+Space，任何界面都能唤出）
//   3. 真文件系统（附件可以写到磁盘目录）
// 另外：原生系统通知（关窗也能弹）、托盘图标。
//
// 编译前提：Rust（rustup）+ Visual Studio Build Tools（勾选「使用 C++ 的桌面开发」）。

use std::fs;
use std::path::PathBuf;

use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    Manager, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_notification::NotificationExt;

/// 打开（或唤起）全局悬浮球小窗
fn open_quick_window(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("quick") {
        w.show().map_err(|e| e.to_string())?;
        w.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    build_quick_window(app)
}

/// 切换：显示中就隐藏，隐藏中就显示（对应全局快捷键）
fn toggle_quick_window(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("quick") {
        if w.is_visible().unwrap_or(false) {
            w.hide().map_err(|e| e.to_string())?;
        } else {
            w.show().map_err(|e| e.to_string())?;
            w.set_focus().map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    build_quick_window(app)
}

/// 隐藏悬浮球小窗（点 × 或按 Esc 时调用）
fn hide_quick_window(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("quick") {
        w.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn build_quick_window(app: &tauri::AppHandle) -> Result<(), String> {
    let win = WebviewWindowBuilder::new(
        app,
        "quick",
        WebviewUrl::App("index.html?quick=1".into()),
    )
    .title("快速收录")
    .inner_size(360.0, 500.0)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .center()
    .build()
    .map_err(|e| e.to_string())?;
    win.show().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn open_quick_window_cmd(app: tauri::AppHandle) -> Result<(), String> {
    open_quick_window(&app)
}

#[tauri::command]
fn hide_quick_window_cmd(app: tauri::AppHandle) -> Result<(), String> {
    hide_quick_window(&app)
}

/// 显示主窗口（小窗里点「打开收集箱」之类要跳回主窗）
#[tauri::command]
fn show_main_window_cmd(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("main") {
        w.show().map_err(|e| e.to_string())?;
        w.unminimize().ok();
        w.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn desktop_notify_cmd(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn desktop_info_cmd() -> serde_json::Value {
    serde_json::json!({
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "family": std::env::consts::FAMILY,
    })
}

#[tauri::command]
fn pick_data_dir_cmd(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog().file().pick_folder(move |folder| {
        let _ = tx.send(folder);
    });
    match rx.recv() {
        Ok(Some(p)) => Ok(Some(p.to_string())),
        _ => Ok(None),
    }
}

#[tauri::command]
fn write_text_file_cmd(path: String, content: String) -> Result<(), String> {
    if let Some(parent) = PathBuf::from(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn register_hotkey_cmd(app: tauri::AppHandle, accelerator: String) -> Result<(), String> {
    // 事件处理统一交给插件的全局 handler（见 main 里的 with_handler），
    // 这里只负责注册按键，避免同一个快捷键被注册两次。
    app.global_shortcut()
        .register(accelerator.as_str())
        .map_err(|e| e.to_string())
}

/// 注销全部全局快捷键。
/// 分发版默认不注册 Alt+Space —— 它会和输入法、截图工具、IDE 抢键，
/// 对「发给朋友用」的场景是负体验，改成用户在设置里主动开启。
#[tauri::command]
fn unregister_all_hotkeys_cmd(app: tauri::AppHandle) -> Result<(), String> {
    app.global_shortcut().unregister_all().map_err(|e| e.to_string())
}

/* ------------------------------------------------------------------ */
/* 分发版新增：让用户看得见自己的数据、报得出自己的版本                    */
/* ------------------------------------------------------------------ */

/// 本机数据目录（IndexedDB 文件就在它下面的 EBWebView 里）
///
/// 注意：Windows 上 WebView2 的数据目录是 **LocalAppData** 下的 `<identifier>\EBWebView`，
/// 不是 Roaming 的 app_data_dir。返回错的路径会让人打开一个空文件夹，
/// 然后以为自己的数据丢了 —— 所以这里两个都查，返回真正有 EBWebView 的那个。
#[tauri::command]
fn data_dir_cmd(app: tauri::AppHandle) -> Result<String, String> {
    let local = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    let roaming = app.path().app_data_dir().map_err(|e| e.to_string())?;
    for p in [&local, &roaming] {
        if p.join("EBWebView").exists() {
            return Ok(p.to_string_lossy().to_string());
        }
    }
    // 还没产生数据（首次启动）：给 Local，也就是它将来会出现的地方
    Ok(local.to_string_lossy().to_string())
}

/// 用 Windows 外壳关联打开（等价于双击），不创建子进程。
#[cfg(target_os = "windows")]
fn shell_open(path: &str) -> Result<(), String> {
    use std::ffi::OsStr;
    use std::iter::once;
    use std::os::windows::ffi::OsStrExt;

    let wide: Vec<u16> = OsStr::new(path).encode_wide().chain(once(0)).collect();
    let verb: Vec<u16> = OsStr::new("open").encode_wide().chain(once(0)).collect();

    unsafe {
        use windows_sys::Win32::UI::Shell::ShellExecuteW;

        // 返回值 > 32 才算成功；<= 32 是错误码（如 SE_ERR_ACCESSDENIED=5）
        let r = ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            wide.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            5, // SW_SHOW
        );
        let code = r as isize;
        if code > 32 {
            Ok(())
        } else {
            Err(match code {
                0 => "内存不足".to_string(),
                2 => "找不到文件/网址打不开（ERROR_FILE_NOT_FOUND）".to_string(),
                3 => "路径不存在（ERROR_PATH_NOT_FOUND）".to_string(),
                5 => "被拒绝（ERROR_ACCESS_DENIED，多半是杀软拦了）".to_string(),
                8 => "内存不足".to_string(),
                26 => "共享冲突".to_string(),
                27 => "文件名关联不完整".to_string(),
                28 => "关联超时".to_string(),
                29 => "关联失败".to_string(),
                30 => "关联忙".to_string(),
                31 => "没有关联的应用程序".to_string(),
                other => format!("错误码 {}", other),
            })
        }
    }
}

/// 把打开失败的尝试写进临时目录的日志。
///
/// 桌面应用没有控制台，spawn 失败的原因看不见就只能靠猜。
/// 写文件是最省事的办法，排查完可以直接忽略这个文件。
fn log_open(line: &str) {
    use std::io::Write;
    use std::time::{SystemTime, UNIX_EPOCH};

    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let p = std::env::temp_dir().join("personal-os-openpath.log");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(p) {
        let _ = writeln!(f, "[{}] {}", secs, line);
    }
}

/// 用系统默认程序打开一个路径或网址。
///
/// 这里踩过两次坑：`explorer <url>` 点了没反应，换成 `cmd /c start` 之后
/// 仍然失败。与其继续猜，改成**依次尝试多种方式，并把每一次的失败原因
/// 写进日志**——下次再失败就能直接看日志定位，不用再盲改。
#[tauri::command]
fn open_path_cmd(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // 首选：ShellExecuteW（外壳关联打开，不创建子进程）
        match shell_open(&path) {
            Ok(()) => {
                log_open(&format!("成功：ShellExecuteW -> {}", path));
                return Ok(());
            }
            Err(e) => log_open(&format!("ShellExecuteW 失败：{}（目标 {}）", e, path)),
        }

        let is_url = path.starts_with("http://") || path.starts_with("https://");
        let mut attempts: Vec<(&str, std::process::Command)> = Vec::new();

        if is_url {
            // 1) rundll32 的 FileProtocolHandler：不经过 cmd，最干净
            let mut c = std::process::Command::new("rundll32");
            c.args(["url.dll,FileProtocolHandler", &path]);
            attempts.push(("rundll32", c));

            // 2) cmd 的 start：等价双击
            let mut c = std::process::Command::new("cmd");
            c.args(["/c", "start", "", &path]);
            attempts.push(("cmd /c start", c));
        }

        // 3) 最后再用 explorer（打开文件夹时它是唯一合适的）
        let mut c = std::process::Command::new("explorer");
        c.arg(&path);
        attempts.push(("explorer", c));

        let mut last = String::new();
        for (name, mut cmd) in attempts {
            match cmd.spawn() {
                Ok(_) => {
                    log_open(&format!("成功：{} -> {}", name, path));
                    return Ok(());
                }
                Err(e) => {
                    last = format!("{} 失败：{}", name, e);
                    log_open(&format!("{}（目标 {}）", last, path));
                }
            }
        }
        return Err(last);
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    // Windows 分支已经提前 return，这里对它来说是不可达的；
    // 但函数需要一个尾表达式才能通过类型检查，所以保留并屏蔽警告。
    #[allow(unreachable_code)]
    Ok(())
}

/// 应用版本（来自 tauri.conf.json，构建时固化进二进制）
#[tauri::command]
fn app_version_cmd(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

/// 桌面端"另存为"：弹系统保存对话框，选好路径后直接写盘。
///
/// 为什么必须有它：
///   前端那套 `Blob + <a download>` 在浏览器里好好的，但在 WebView2 里
///   **点了完全没反应** —— WebView 的下载事件需要宿主自己接管，
///   Tauri 默认不管。表现就是用户点「导出 JSON」什么都没发生，
///   还以为软件坏了。桌面端必须走原生保存。
///
/// 返回 None 表示用户取消了（不是错误，不要弹提示）。
#[tauri::command]
fn save_text_file_cmd(
    app: tauri::AppHandle,
    default_name: String,
    content: String,
) -> Result<Option<String>, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .add_filter("备份文件", &["json", "md", "ics", "txt"])
        .add_filter("所有文件", &["*"])
        .set_file_name(&default_name)
        .save_file(move |file| {
            let _ = tx.send(file);
        });
    match rx.recv() {
        Ok(Some(fp)) => {
            let path = fp.into_path().map_err(|e| e.to_string())?;
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::write(&path, content.as_bytes()).map_err(|e| e.to_string())?;
            Ok(Some(path.to_string_lossy().to_string()))
        }
        _ => Ok(None), // 用户取消，或对话框异常关闭
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    // 只处理按下，避免抬起时再触发一次
                    // 用 toggle：再按一次 Alt+Space 就能关掉浮球
                    if event.state == ShortcutState::Pressed {
                        let _ = toggle_quick_window(app);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            open_quick_window_cmd,
            hide_quick_window_cmd,
            show_main_window_cmd,
            desktop_notify_cmd,
            desktop_info_cmd,
            pick_data_dir_cmd,
            write_text_file_cmd,
            register_hotkey_cmd,
            unregister_all_hotkeys_cmd,
            data_dir_cmd,
            open_path_cmd,
            app_version_cmd,
            save_text_file_cmd,
        ])
        // 关掉主窗口 = 彻底退出应用。
        // 否则"快速收录"浮球小窗会让进程留在后台（它无边框、不在任务栏，
        // 用户以为已经关了），表现就是"明明关了安装时还说正在运行"。
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if window.label() == "main" {
                    window.app_handle().exit(0);
                }
            }
        })
        .setup(|app| {
            // 托盘：右键菜单（打开主窗 / 快速收录 / 退出）
            let show = MenuItemBuilder::with_id("show", "打开主窗口").build(app)?;
            let quick = MenuItemBuilder::with_id("quick", "快速收录").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "退出").build(app)?;
            let menu = MenuBuilder::new(app)
                .item(&show)
                .item(&quick)
                .separator()
                .item(&quit)
                .build()?;

            let handle = app.handle().clone();
            TrayIconBuilder::new()
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |_app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = handle.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "quick" => {
                        let _ = toggle_quick_window(&handle);
                    }
                    "quit" => std::process::exit(0),
                    _ => {}
                })
                .build(app)?;

            // 全局快捷键：分发版**默认不注册**。
            // 开启前它是"任何界面都能唤出收集箱"的利器，但它会抢输入法/截图工具的键，
            // 对第一次用这个软件的人是负体验。需要的人在「设置 → 界面」里手动开启。
            // 前端开启时调用 register_hotkey；关闭时调用 unregister_all_hotkeys。

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("启动 Tauri 失败");
}
