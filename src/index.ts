import { isAfter, subDays } from 'date-fns';

type Channel = {
	name: string;
	id: string;
};

type Message = {
	id: string;
	content: string;
	username: string;
	timestamp: string;
};

type DiscordMessages = any[];

const CHANNELS: Channel[] = [{ name: '#development-chat', id: '1209845180010856508' }];
const DAYS = 7;

export default {
	// Oh?! The horror :lul: Good luck... to future me...
	async fetch(request: Request, env: Env) {
		const data = await Promise.all(
			CHANNELS.map((channel) =>
				getMessages(env.DISCORD_API_TOKEN, channel, subDays(new Date(), DAYS))
					.then((messages) =>
						messages.map(({ id, content, author: { username }, timestamp }) => ({ id, content, username, timestamp }) as Message),
					)
					.then((messages) => ({ channel, messages })),
			),
		);

		const summaries = await Promise.all(
			data.map((channel) => getSummary(env.OPEN_AI_TOKEN, channel.messages).then((summary) => ({ summary, channel: channel.channel }))),
		);

		const response = summaries.map(
			({ summary, channel }) =>
				`## <#${channel.id}>\n` + summary.map((topic) => `- **${topic.topicName}:** ${topic.shortSummary}`).join('\n'),
		);

		return Response.json(response);
	},
	async scheduled(event: ScheduledEvent, env: Env): Promise<void> {},
};

const getMessages = async (
	token: string,
	channel: Channel,
	until: Date,
	before?: string,
	messages: DiscordMessages = [],
): Promise<DiscordMessages> => {
	let url = `https://discord.com/api/v10/channels/${channel.id}/messages?limit=100`;
	if (before) {
		url = url + `&before=${before}`;
	}

	console.log(`[${channel.name}] Fetching 100 messages, prior to message ID: ${before ?? '<nil>'}...`);

	const response = await fetch(url, {
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bot ${token}`,
		},
	});

	const data = (await response.json()) as any;

	if (!response.ok) {
		if (data.message === 'You are being rate limited.') {
			const waitTime = data.retry_after * 1000 + 100;

			console.log(`[${channel.name}] API rate limit detected, waiting ${waitTime}ms...`);
			await wait(waitTime);

			return getMessages(token, channel, until, before, messages);
		}

		console.log(`[${channel.name}] An API error occured (${data.message}), returning the ${messages.length} messages collected.`);

		return messages;
	}

	console.log(`[${channel.name}] Fetched ${data.length} messages...`);

	const { id, timestamp } = data[data.length - 1];
	if (isAfter(new Date(timestamp), until)) {
		return getMessages(token, channel, until, id, [...messages, ...data]);
	}

	console.log(`[${channel.name}] Complete! Collected ${messages.length + data.length} messages!`);

	return [...messages, ...data];
};

const getSummary = async (token: string, messages: Message[]): Promise<{ topicName: string; shortSummary: string }[]> => {
	const prompt =
		'I will provide the chat log for a channel on a Discord server from the past 7 days.' +
		'It will be provided in JSON format. This JSON will be sorted by date.' +
		'It will includes fields for the `content` of the message, the `username` that sent the message, and the `timestamp` it was sent at.' +
		'The chat topics will vary, with some conversations happening in parallel.' +
		'You should provide a list of the topics discussed over the past 7 days as an array of objects in JSON format.' +
		'Each object should contain a `topicName`, a `shortSummary`.';

	console.log(`Getting summary for ${messages.length} messages from gpt-4-turbo...`);

	const response = await fetch('https://api.openai.com/v1/chat/completions', {
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${token}`,
		},
		method: 'POST',
		body: JSON.stringify({
			model: 'gpt-4-turbo',
			// What sampling temperature to use, between 0 and 2.
			// Higher values like 0.8 will make the output more random,
			// while lower values like 0.2 will make it more focused and deterministic.
			temperature: 0.2,
			messages: [
				{
					role: 'system',
					content: prompt,
				},
				{
					role: 'user',
					content: JSON.stringify(messages),
				},
			],
		}),
	});

	const body = (await response.json()) as { choices: { message: { content: string } }[] };

	if (!response.ok) {
		console.log(body);
		throw new Error('OpenAI unavailable');
	}

	return body.choices.map(({ message: { content } }) => JSON.parse(content)).flat();
};

const wait = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));
