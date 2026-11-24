# Pasted config

When the user pastes the YAML instead of naming a file:

1. Write it unchanged to a temporary file outside the project with the Write
   tool.
2. Run Steps 3 and 4 on that file, giving diffs against the pasted text.
3. Skip Step 2 and Step 5: write no test report, and in headless mode report
   `artifacts: []`.
4. Offer to save it as `<name>.yaml` so a report can be written.
