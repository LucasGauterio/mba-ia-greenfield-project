const mailpitUrl = `http://${process.env.MAIL_HOST ?? 'mailpit'}:8025`;

interface MailpitAddress {
  Name: string;
  Address: string;
}

/** A row from `GET /api/v1/messages` (the Mailpit message list). */
export interface MailpitMessageSummary {
  ID: string;
  MessageID: string;
  Read: boolean;
  From: MailpitAddress;
  To: MailpitAddress[];
  Subject: string;
  Created: string;
  Size: number;
  Snippet: string;
}

/** The full message from `GET /api/v1/message/{id}`. */
export interface MailpitMessage extends MailpitMessageSummary {
  Date: string;
  Text: string;
  HTML: string;
}

export async function getMailpitMessages(): Promise<MailpitMessageSummary[]> {
  const res = await fetch(`${mailpitUrl}/api/v1/messages`);
  const data = (await res.json()) as { messages: MailpitMessageSummary[] };
  return data.messages;
}

export async function getMailpitMessage(id: string): Promise<MailpitMessage> {
  const res = await fetch(`${mailpitUrl}/api/v1/message/${id}`);
  return (await res.json()) as MailpitMessage;
}

export async function clearMailpitMessages(): Promise<void> {
  await fetch(`${mailpitUrl}/api/v1/messages`, { method: 'DELETE' });
}
