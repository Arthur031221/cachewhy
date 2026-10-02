Output assets/demo.gif

Set Shell "bash"
Set FontSize 18
Set Width 1080
Set Height 640
Set Padding 20
Set TypingSpeed 10ms
Set Theme "Catppuccin Mocha"

Hide
Type "unset NO_COLOR; export PS1='$ ' FORCE_COLOR=1; clear; node bin/cachewhy.js http://127.0.0.1:3033/missing.js" Enter
Sleep 1s
Show
Sleep 7s
Type "node bin/cachewhy.js 'http://127.0.0.1:3033/missing.js?fixed=1'" Enter
Sleep 8s
