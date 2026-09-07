@echo off
rem Questlog.cmd — no-shortcut fallback launcher. Double-clickable from the
rem desktop\ folder; a brief minimised console is the whole cost.
start "" /min node "%~dp0launch.mjs"
