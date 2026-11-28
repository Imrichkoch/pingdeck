for (const link of document.querySelectorAll('[data-language]')) {
  link.addEventListener('click', () => {
    const url = new URL(link.href)
    url.hash = location.hash
    link.href = url.href
  })
}
