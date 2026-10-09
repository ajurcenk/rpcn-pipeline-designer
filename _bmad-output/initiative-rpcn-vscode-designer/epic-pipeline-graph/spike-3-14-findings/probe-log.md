# Probe log, VS Code 1.141.0 (stable)
- commands: lockEditorGroup=true unlockEditorGroup=true toggleEditorGroupLock=true
- 1 opened a.yaml: groups=col1*[text:a.yaml(active)]; activeGroup=col1; activeTextEditor=a.yaml@col1
- 2 after Show graph (preserveFocus): groups=col1*[text:a.yaml(active)] col2[webview:Graph: a.yaml(active)]; activeGroup=col1; activeTextEditor=a.yaml@col1
- 3 after reveal(graph, focus): groups=col1[text:a.yaml(active)] col2*[webview:Graph: a.yaml(active)]; activeGroup=col2; activeTextEditor=a.yaml@col1
- 4 after lockEditorGroup: groups=col1[text:a.yaml(active)] col2*[webview:Graph: a.yaml(active)]; activeGroup=col2; activeTextEditor=a.yaml@col1
- 5 after showTextDocument(a, col1) = focus return: groups=col1*[text:a.yaml(active)] col2[webview:Graph: a.yaml(active)]; activeGroup=col1; activeTextEditor=a.yaml@col1
- 6 graph group active, vscode.open(b) (no column): groups=col1*[text:b.yaml(active)] col2[webview:Graph: a.yaml(active)]; activeGroup=col1; activeTextEditor=b.yaml@col1
- 7 showTextDocument(c, graph column explicitly): groups=col1[text:b.yaml(active)] col2*[webview:Graph: a.yaml, text:c.yaml(active)]; activeGroup=col2; activeTextEditor=c.yaml@col2
- 8 Show graph for b.yaml from col1: groups=col1*[text:a.yaml(active)] col3[webview:Graph: a.yaml, text:c.yaml(active)] col2[webview:Graph: b.yaml(active)]; activeGroup=col1; activeTextEditor=a.yaml@col1
- 9 control (no lock): graph group active, vscode.open(b): groups=col1[text:a.yaml(active)] col2*[webview:Graph: a.yaml, text:b.yaml(active)]; activeGroup=col2; activeTextEditor=b.yaml@col2
- 10 lock with YAML group active: groups=col1*[text:a.yaml(active)] col2[webview:Graph: a.yaml(active)]; activeGroup=col1; activeTextEditor=a.yaml@col1
- 11 then vscode.open(c) from the YAML group: groups=col1[text:a.yaml(active)] col2*[webview:Graph: a.yaml, text:c.yaml(active)]; activeGroup=col2; activeTextEditor=c.yaml@col2
- VS Code 1.141.0

# Probe log, VS Code 1.100.0 (floor)
- commands: lockEditorGroup=true unlockEditorGroup=true toggleEditorGroupLock=true
- 1 opened a.yaml: groups=col1*[text:a.yaml(active)]; activeGroup=col1; activeTextEditor=a.yaml@col1
- 2 after Show graph (preserveFocus): groups=col1*[text:a.yaml(active)] col2[webview:Graph: a.yaml(active)]; activeGroup=col1; activeTextEditor=a.yaml@col1
- 3 after reveal(graph, focus): groups=col1[text:a.yaml(active)] col2*[webview:Graph: a.yaml(active)]; activeGroup=col2; activeTextEditor=none
- 4 after lockEditorGroup: groups=col1[text:a.yaml(active)] col2*[webview:Graph: a.yaml(active)]; activeGroup=col2; activeTextEditor=none
- 5 after showTextDocument(a, col1) = focus return: groups=col1*[text:a.yaml(active)] col2[webview:Graph: a.yaml(active)]; activeGroup=col1; activeTextEditor=a.yaml@col1
- 6 graph group active, vscode.open(b) (no column): groups=col1*[text:a.yaml, text:b.yaml(active)] col2[webview:Graph: a.yaml(active)]; activeGroup=col1; activeTextEditor=b.yaml@col1
- 7 showTextDocument(c, graph column explicitly): groups=col1[text:a.yaml, text:b.yaml(active)] col2*[webview:Graph: a.yaml, text:c.yaml(active)]; activeGroup=col2; activeTextEditor=c.yaml@col2
- 8 Show graph for b.yaml from col1: groups=col1*[text:a.yaml(active), text:b.yaml] col3[webview:Graph: a.yaml, text:c.yaml(active)] col2[webview:Graph: b.yaml(active)]; activeGroup=col1; activeTextEditor=c.yaml@col3
- 9 control (no lock): graph group active, vscode.open(b): groups=col1[text:a.yaml(active)] col2*[webview:Graph: a.yaml, text:b.yaml(active)]; activeGroup=col2; activeTextEditor=b.yaml@col2
- 10 lock with YAML group active: groups=col1*[text:a.yaml(active)] col2[webview:Graph: a.yaml(active)]; activeGroup=col1; activeTextEditor=a.yaml@col1
- 11 then vscode.open(c) from the YAML group: groups=col1[text:a.yaml(active)] col2*[webview:Graph: a.yaml, text:c.yaml(active)]; activeGroup=col2; activeTextEditor=c.yaml@col2
- VS Code 1.100.0
