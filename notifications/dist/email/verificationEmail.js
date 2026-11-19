export function buildVerificationEmail(input) {
    const events = input.eventTypes
        .map((event) => `<li>${escapeHtml(event)}</li>`)
        .join('');
    const html = `<!doctype html>
<html lang="en">
  <body style="font-family: Arial, sans-serif; color: #111827; line-height: 1.6;">
    <div style="max-width: 600px; margin: 0 auto; padding: 32px;">
      <h1 style="font-size: 24px; margin-bottom: 16px;">Verify your ILN notifications</h1>
      <p>You asked to receive email notifications for Stellar address <strong>${escapeHtml(input.address)}</strong>.</p>
      <p>We will send updates for:</p>
      <ul>${events}</ul>
      <p style="margin: 24px 0;">
        <a href="${escapeAttribute(input.verifyUrl)}" style="display: inline-block; background: #111827; color: #ffffff; text-decoration: none; padding: 12px 18px; border-radius: 8px;">
          Verify email address
        </a>
      </p>
      <p>If you did not request these notifications, you can ignore this email or unsubscribe below.</p>
      <p style="font-size: 12px; color: #6b7280;">
        Unsubscribe: <a href="${escapeAttribute(input.unsubscribeUrl)}">${escapeHtml(input.unsubscribeUrl)}</a>
      </p>
    </div>
  </body>
</html>`;
    const text = [
        'Verify your ILN notifications',
        `Address: ${input.address}`,
        `Email: ${input.email}`,
        `Events: ${input.eventTypes.join(', ')}`,
        `Verify: ${input.verifyUrl}`,
        `Unsubscribe: ${input.unsubscribeUrl}`,
    ].join('\n');
    return {
        subject: 'Verify your ILN email notifications',
        html,
        text,
    };
}
function escapeHtml(value) {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
}
function escapeAttribute(value) {
    return escapeHtml(value).replaceAll('"', '&quot;');
}
