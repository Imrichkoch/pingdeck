import { translate } from './locale.js'

const t = source => translate(document.documentElement.lang, source)
const code = location.hash.match(/^#code=([\w-]{22})$/)?.[1]
const result = document.querySelector('#pair-fallback-feedback')

if (code) {
  document.querySelector('#pair-fallback').hidden = false
  const field = document.querySelector('#pair-fallback-code')
  field.value = code
  document.querySelector('#pair-fallback-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(code)
      result.textContent = t('Kód je v schránke.')
    } catch {
      field.select()
      result.textContent = t('Schránka nie je dostupná. Označ a skopíruj text ručne.')
    }
  })
} else {
  result.textContent = t('V odkaze chýba platný párovací kód. Otvor pôvodnú pozvánku.')
}
