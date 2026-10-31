' 个人工作台 · 信息聚合服务 —— 开机自动启动
'
' 作用：开机后在后台跑起聚合服务（负责定时抓取 RSS / 网页公告），
'       信息流页面才能读到数据。窗口以最小化方式运行，不打扰你。
'
' 不想再自动启动：删掉这个文件即可（不影响任何数据）。
' 想手动控制：直接双击 aggregator 目录下的「启动工作台.bat」。

Set ws = CreateObject("WScript.Shell")

aggDir = "C:\Users\84072\WorkBuddy\WorkBuddy日常管理库\aggregator"
pyExe  = "C:\Users\84072\.workbuddy\binaries\python\versions\3.13.12\python.exe"

' 开机时不要弹浏览器（平时双击 .bat 才需要）
ws.Environment("PROCESS")("AGG_NO_BROWSER") = "1"
ws.CurrentDirectory = aggDir

' 第 2 个参数 7 = 最小化运行且不等待
ws.Run """" & pyExe & """ main.py", 7, False
