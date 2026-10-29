const parameters = new URLSearchParams(location.search);
document.querySelector('[data-command-path]').textContent = parameters.get('commandPath') || '';
for (const path of parameters.getAll('profilePath')) {
  const line = document.createElement('p');
  line.className = 'confirmation-path'; line.textContent = path;
  document.querySelector('[data-profile-paths]').append(line);
}
for (const button of document.querySelectorAll('[data-choice]')) button.addEventListener('click', () => {
  location.hash = button.dataset.choice === 'install' ? 'install' : 'cancel';
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); location.hash = 'cancel'; }
});
document.querySelector('[data-choice="cancel"]').focus();
