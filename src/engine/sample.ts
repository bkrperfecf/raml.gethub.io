/** Builds demo single-file HTML projects (small showcase or a synthetic ~20k-line stress test). */

export function makeSample(scale: 'demo' | 'stress'): { name: string; html: string } {
  const sections = scale === 'stress' ? 220 : 4;
  const fnCount = scale === 'stress' ? 420 : 14;
  const cssRules = scale === 'stress' ? 900 : 24;

  let css = '';
  for (let i = 0; i < cssRules; i++) {
    css += `  .card-${i} {\n    padding: ${8 + (i % 6)}px;\n    border-radius: ${4 + (i % 8)}px;\n    background: hsl(${(i * 13) % 360} 60% 96%);\n  }\n`;
    if (i % 9 === 0) css += `  @media (max-width: ${480 + (i % 5) * 100}px) {\n    .card-${i} { padding: 4px; }\n  }\n`;
  }

  let body = '';
  for (let i = 0; i < sections; i++) {
    body += `  <section id="section-${i + 1}" class="panel">\n    <h2>Section ${i + 1}</h2>\n    <p>Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>\n    <ul>\n`;
    for (let k = 0; k < (scale === 'stress' ? 12 : 3); k++) body += `      <li class="card-${(i + k) % cssRules}" data-id="${i}-${k}">Item ${k + 1}</li>\n`;
    body += `    </ul>\n    <button onclick="greet('section ${i + 1}')">Say hi</button>\n  </section>\n`;
  }

  let js1 = `/* ===== Part 1: bootstrap ===== */\nconst APP_NAME = 'Modular Demo';\nconst log = (...a) => console.log('[app]', ...a);\n\n`;
  for (let i = 0; i < fnCount; i++) {
    js1 += `// helper ${i}\nfunction helper${i}(x) {\n  const label = \`h${i}:\${x}\`;\n  if (x > ${i}) {\n    return label.toUpperCase();\n  }\n  return label + '\\n' + "it's ok";\n}\n\n`;
  }
  js1 += `function boot() {\n  log('booting', APP_NAME);\n}\n\nfunction greet(name) {\n  alert('Hello from ' + name + ' (' + helper1(3) + ')');\n}\n\nboot();\n\ndocument.addEventListener('DOMContentLoaded', () => {\n  document.title = APP_NAME + ' - ready';\n  log('DOMContentLoaded handled, sections =', document.querySelectorAll('section').length);\n});\nwindow.addEventListener('load', () => log('window load handled'));\n`;

  const html = `<!DOCTYPE html>
<html lang="en" class="theme-light" data-build="42">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>Modularizer Demo App</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap" rel="stylesheet">
  <style>
    :root { --brand: #4f46e5; }
    body { font-family: Inter, system-ui, sans-serif; margin: 0; }
    .panel { padding: 16px; border-bottom: 1px solid #e5e7eb; }
    /* a } inside a string must not confuse the splitter */
    .quote::after { content: "}"; }
${css}  </style>
  <script src="https://cdn.jsdelivr.net/npm/dayjs@1/dayjs.min.js"></script>
</head>
<body class="app-shell" id="top" data-mode="demo" style="background:#fafafa">
  <header class="site-header">
    <nav><a href="#section-1">Home</a> <a href="#section-2">Docs</a></nav>
  </header>
  <!-- main area -->
  <main id="app">
${body}  </main>
  <div id="login-modal" class="modal" hidden>
    <div class="modal-body">Hello modal <button onclick="document.getElementById('login-modal').hidden = true">Close</button></div>
  </div>
  <template id="row-tpl"><tr><td>row</td></tr></template>
  <footer class="site-footer"><small>&copy; 2026 Demo</small></footer>

  <script type="application/json" id="seed">{"hello":"world"}</script>
  <script>
${js1}  </script>
  <script type="module">
    const mod = await Promise.resolve('module ok');
    console.log('[module]', mod);
  </script>
</body>
</html>
`;
  return { name: scale === 'stress' ? 'stress-test-app.html' : 'demo-app.html', html };
}
