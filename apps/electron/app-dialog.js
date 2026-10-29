const parameters = new URLSearchParams(location.search);
const cancelIndex = Number(parameters.get('cancel')) || 0;
const defaultIndex = Number(parameters.get('default')) || 0;
document.body.dataset.kind = parameters.get('kind') === 'error' ? 'error' : 'question';
const title = parameters.get('title') || 'AgentForge';
document.title = title;
document.querySelector('[data-dialog-title]').textContent = title;
document.querySelector('[data-dialog-message]').textContent = parameters.get('message') || '';
const detail = parameters.get('detail') || '';
if (detail) {
  const node = document.querySelector('[data-dialog-detail]');
  node.textContent = detail;
  node.hidden = false;
}
const footer = document.querySelector('[data-dialog-buttons]');
parameters.getAll('button').forEach((label, index) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = index === defaultIndex ? 'primary-button' : 'ghost-button';
  button.dataset.dialogChoice = String(index);
  button.textContent = label;
  button.addEventListener('click', () => { location.hash = `choice-${index}`; });
  footer.append(button);
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); location.hash = `choice-${cancelIndex}`; }
});
footer.querySelectorAll('button')[defaultIndex]?.focus();
