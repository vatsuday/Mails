// App-wide state shared by the pages.
export const state = {
  user: null, // { id, name, email, role, signature_html }
  app: null, // { name, smtpConfigured, fromEmail, fromName, maxAttachmentBytes, maxRecipients, defaultPassword }
  // Set by Templates / History / Contacts to pre-fill the compose or bulk page on the next visit.
  handoff: null,
};

export const isAdmin = () => state.user?.role === 'admin';
