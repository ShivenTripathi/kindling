use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use lettre::message::{header::ContentType, Attachment, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::Credentials;
use lettre::{Message, SmtpTransport, Transport};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmtpOpts {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub from: String,
    pub to: String,
    pub subject: String,
    pub body_text: String,
    pub attachment_b64: String,
    pub attachment_name: String,
}

/// Sends `opts` as an email with a base64-decoded EPUB attachment over
/// implicit-TLS SMTP (e.g. smtp.gmail.com:465). Never logs or includes the
/// password in any returned error.
#[tauri::command]
pub fn send_smtp(opts: SmtpOpts) -> Result<(), String> {
    let attachment_bytes = BASE64
        .decode(opts.attachment_b64.as_bytes())
        .map_err(|e| format!("could not decode attachment base64: {e}"))?;

    let epub_content_type = ContentType::parse("application/epub+zip")
        .map_err(|e| format!("invalid attachment content type: {e}"))?;

    let attachment_part =
        Attachment::new(opts.attachment_name.clone()).body(attachment_bytes, epub_content_type);

    let text_part = SinglePart::plain(opts.body_text.clone());

    let multipart = MultiPart::mixed()
        .singlepart(text_part)
        .singlepart(attachment_part);

    let email = Message::builder()
        .from(
            opts.from
                .parse()
                .map_err(|e| format!("invalid \"from\" address: {e}"))?,
        )
        .to(opts
            .to
            .parse()
            .map_err(|e| format!("invalid \"to\" address: {e}"))?)
        .subject(opts.subject.clone())
        .multipart(multipart)
        .map_err(|e| format!("could not build email message: {e}"))?;

    let creds = Credentials::new(opts.username.clone(), opts.password.clone());

    let transport = if opts.port == 465 {
        SmtpTransport::relay(&opts.host)
            .map_err(|e| smtp_build_error(&e))?
            .credentials(creds)
            .build()
    } else {
        SmtpTransport::starttls_relay(&opts.host)
            .map_err(|e| smtp_build_error(&e))?
            .port(opts.port)
            .credentials(creds)
            .build()
    };

    transport.send(&email).map_err(|e| smtp_send_error(&e))?;

    Ok(())
}

/// Formats a transport-build error without ever risking password inclusion
/// (lettre's builder errors are connection/TLS errors, not credential dumps,
/// but we still keep the message minimal and generic).
fn smtp_build_error(e: &lettre::transport::smtp::Error) -> String {
    format!("could not connect to SMTP host: {e}")
}

fn smtp_send_error(e: &lettre::transport::smtp::Error) -> String {
    format!("could not send email: {e}")
}
