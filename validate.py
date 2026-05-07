with open('website/index.html', 'r', encoding='utf-8') as f:
    html = f.read()

issues = []
open_div = html.count('<div')
close_div = html.count('</div>')
if open_div != close_div:
    issues.append(f'div mismatch: open={open_div}, close={close_div}')

open_section = html.count('<section')
close_section = html.count('</section>')
if open_section != close_section:
    issues.append(f'section mismatch: open={open_section}, close={close_section}')

open_button = html.count('<button')
close_button = html.count('</button>')
if open_button != close_button:
    issues.append(f'button mismatch: open={open_button}, close={close_button}')

if issues:
    for i in issues:
        print('ISSUE:', i)
else:
    print('No obvious tag mismatches found')

# Also check for common issues
if '<img' in html and html.count('<img') != html.count('>'):
    # img tags might be self-closing
    pass

print('Validation complete.')
