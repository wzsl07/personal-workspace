' 个人工作台 · 信息聚合服务 —— 开机自动启动
'
' 作用：开机后在后台跑起聚合服务（负责定时抓取 RSS / 网页公告），
'       这样「信息流」页面才读得到数据。
'       用的是 pythonw，不会弹出任何窗口。
'
' 不想再自动启动：删掉这个文件即可（不影响任何数据）。
' 想手动控制：双击 aggregator 目录下的「启动工作台.bat」。

Set ws = CreateObject("WScript.Shell")

aggDir = "C:\Users\84072\WorkBuddy\WorkBuddy日常管理库\aggregator"
pywExe = "C:\Users\84072\.workbuddy\binaries\python\versions\3.13.12\pythonw.exe"

' 开机时不要弹浏览器（平时双击 .bat 才需要）
ws.Environment("PROCESS")("AGG_NO_BROWSER") = "1"
ws.CurrentDirectory = aggDir

' 第 2 个参数 0 = 隐藏窗口；False = 不等待它结束
ws.Run """" & pywExe & """ main.py", 0, False
