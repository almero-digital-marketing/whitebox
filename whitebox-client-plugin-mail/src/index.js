// Mail plugin — submits contact-form data to whitebox-server's POST /mail/inbox.
// The route is public on the server, so no auth header is required.

export default function mailPlugin() {
  return {
    name: 'mail',
    install(core) {
      const { http, queue, logger } = core

      async function submit({ from, subject, body, files, to, data } = {}) {
        if (!from)    throw new Error('mail.submit: `from` is required')
        if (!subject) throw new Error('mail.submit: `subject` is required')

        return queue(async () => {
          // If files are provided, send as multipart so multer parses them server-side.
          // Otherwise plain JSON.
          if (files && files.length) {
            const fd = new FormData()
            fd.append('from', from)
            fd.append('subject', subject)
            if (body) fd.append('body', body)
            if (to) fd.append('to', to)
            if (data) fd.append('data', JSON.stringify(data))
            for (const f of files) fd.append('files', f, f.name)
            return http.request('/mail/inbox', { method: 'POST', body: fd })
          }

          return http.request('/mail/inbox', {
            method: 'POST',
            body: { from, subject, body, to, data },
          })
        })
      }

      core.attach('mail', { submit })
    },
  }
}
