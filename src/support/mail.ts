import nodemailer from 'nodemailer'
import { config } from '../config.js'

/**
 * Outgoing email (password resets), over SMTP. With MAIL_MAILER=array messages are kept in memory instead,
 * for tests.
 */
export interface MailMessage {
    to: string
    subject: string
    text: string
    html: string
}

const sent: MailMessage[] = []

export async function sendMail(message: MailMessage): Promise<void> {
    if (config.mail.mailer === 'array' || config.mail.mailer === 'log') {
        sent.push(message)
        return
    }
    const transport = nodemailer.createTransport({
        host: config.mail.host,
        port: config.mail.port,
        secure: config.mail.scheme === 'smtps' || config.mail.port === 465,
        auth: config.mail.username ? { user: config.mail.username, pass: config.mail.password } : undefined,
    })
    await transport.sendMail({
        from: config.mail.fromAddress ? { name: config.mail.fromName, address: config.mail.fromAddress } : undefined,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
    })
}

export const Mail = {
    sent: () => sent,
    reset: () => {
        sent.length = 0
    },
}
