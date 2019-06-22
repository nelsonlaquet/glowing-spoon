const { trainingKey, azureMachineLearningUrl } = require("./config.js");

const {
	readFileSync,
	statSync,
	existsSync,
	createWriteStream,
	createReadStream,
	rename,
	copyFile,
} = require("fs");
const { createHash } = require("crypto");
const request = require("request");
const fetch = require("node-fetch");
const FormData = require("form-data");
const Jimp = require("jimp");

const percentRegex = /^([\-\d]+)\%$/;
const pxRegex = /^([\-\d]+)\px$/;
const allDigitRegex = /^\d+$/;

const urlTransform = /^\/\//;
const toTag = [
	"rainbowdash",
	"twilightsparkle",
	"pinkiepie",
	"fluttershy",
	"rarity",
	"applejack",
	"luna",
	"vinylscratch",
	"octavia",
	"lyra",
	"scootaloo",
	"sweetiebelle",
	"derpy",
	"celestia",
	"applebloom",
	"spike",
	"trixie",
	"berrypunch",
	"bonbon",
	"doctorwhooves",
	"cheerilee",
	"cloudchaser",
	"discord",
	"bigmac",
	"sunsetshimmer",
	"maud",
	"chrysalis",
	"colgate",
	"cadance",
	"pinkamina",
	"roseluck",
	"spitfire",
	"zecora",
	"braeburn",
	"littlepip",
	"shiningarmor",
	"blackjack",
	"flufflepuff",
];

main();

async function main() {
	const emotes = [];
	const emotesByTag = {};
	const rawEmotes = JSON.parse(readFileSync("./emotes.json"));
	for (const rawEmote of rawEmotes) {
		const emote = getEmoteInfo(rawEmote);
		emotes.push(emote);
		for (const tagName of rawEmote.tags) {
			const tag = emotesByTag[tagName]
				? emotesByTag[tagName]
				: (emotesByTag[tagName] = []);
			tag.push(emote);
		}
	}

	const workerCount = 10;
	const emotesPerWorker = Math.ceil(emotes.length / workerCount);

	const downloadWorkers = [];
	for (let i = 0; i < workerCount; i++)
		downloadWorkers.push(
			downloadEmoteWorker(emotes, i * emotesPerWorker, emotesPerWorker),
		);
	await Promise.all(downloadWorkers);

	const renderWorkers = [];
	for (let i = 0; i < workerCount; i++)
		renderWorkers.push(
			renderFinalEmoteImageWorker(
				emotes,
				i * emotesPerWorker,
				emotesPerWorker,
			),
		);
	await Promise.all(renderWorkers);

	return;

	const getTagResponse = await fetch(`${azureMachineLearningUrl}/tags`, {
		method: "GET",
		headers: {
			"Training-Key": trainingKey,
		},
	});

	const tagMap = {};
	for (const res of await getTagResponse.json()) {
		tagMap[res.name] = res.id;
	}

	for (const tag of toTag) {
		const taggedEmotes = emotesByTag[tag];
		if (!taggedEmotes || !taggedEmotes.length) {
			console.error(`Tag ${tag} has no emotes?!`);
			continue;
		}

		if (!tagMap[tag]) {
			const setTagResponse = await fetch(
				`${azureMachineLearningUrl}/tags?name=${tag}`,
				{
					method: "POST",
					headers: {
						"Training-Key": trainingKey,
					},
				},
			);

			const setTagResult = await setTagResponse.json();
			tagMap[tag] = setTagResult.id;
		}

		console.log(`Picking up to 10 emotes for tag ${tag}`);
		const body = {};
		let emoteCount = 0;
		let i = 0;

		while (emoteCount < Math.min(taggedEmotes.length, 20)) {
			const { finalFilename, canonName } = taggedEmotes[i++];
			if (!existsSync(finalFilename)) continue;

			body[`${canonName}.png`] = createReadStream(finalFilename);
			emoteCount++;
		}

		await new Promise(res => {
			request(
				{
					url: `${azureMachineLearningUrl}/images?tagIds=${
						tagMap[tag]
					}`,
					method: "POST",
					headers: {
						"Training-Key": trainingKey,
					},
					formData: body,
				},
				(err, response, body) => {
					console.log(err);
					res();
				},
			);
		});
	}
}

async function downloadEmoteWorker(emotes, start, count) {
	const end = start + count;
	for (let i = start; i < end && i < emotes.length; i++) {
		const { emoteImage, filename, canonName } = emotes[i];

		if (!filename) {
			console.log(`Emote ${canonName} has no image :(`);
			continue;
		}

		if (existsSync(filename)) continue;

		console.log(`Downloading ${canonName}: ${emoteImage}`);
		const response = await fetch(emoteImage);
		await new Promise(res =>
			response.body.pipe(createWriteStream(filename)).on("finish", res),
		);
	}
}

async function renderFinalEmoteImageWorker(emotes, start, count) {
	const end = start + count;
	for (let i = start; i < end && i < emotes.length; i++) {
		const { filename, canonName, finalFilenames, emote } = emotes[i];

		if (emote.apng_url) continue;

		for (const finalFilename of finalFilenames) {
			if (existsSync(finalFilename)) continue;

			let file;

			try {
				file = await Jimp.read(filename);
			} catch (e) {
				console.error(
					`Could not read file for ${canonName}: ${e.message}`,
				);
				continue;
			}

			const isSprited =
				file.bitmap.width != emote.width ||
				file.bitmap.height != emote.height;
			if (isSprited) {
				const { "background-position": bgPosition = [0, 0] } = emote;

				emote.width = parseInt(emote.width);
				emote.height = parseInt(emote.height);

				bgPosition[0] = parseBgPosition(
					bgPosition[0],
					emote.width,
					file.bitmap.width,
				);
				bgPosition[1] = parseBgPosition(
					bgPosition[1],
					emote.height,
					file.bitmap.height,
				);

				emote.width = Math.min(
					emote.width,
					file.bitmap.width - bgPosition[0],
				);
				emote.height = Math.min(
					emote.height,
					file.bitmap.height - bgPosition[1],
				);

				console.log(
					`Chopping ${canonName}; x:${bgPosition[0]}, y:${
						bgPosition[1]
					}, w:${emote.width}, h:${emote.height}`,
				);

				try {
					file.crop(
						bgPosition[0],
						bgPosition[1],
						emote.width,
						emote.height,
					).write(finalFilename);
				} catch (e) {
					console.error(e.msesage);
				}
			} else {
				console.log(`Moving ${canonName} to its final resting place`);
				await new Promise(res => {
					copyFile(filename, finalFilename, res);
				});
			}
		}
	}
}

function getEmoteInfo(emote) {
	const {
		"background-image": emoteImage = "",
		names: [canonName],
	} = emote;
	return {
		emote,
		canonName,
		emoteImage: emoteImage.replace(urlTransform, "https://"),
		finalFilenames:
			emoteImage != null ? emote.names.map(n => `./emotes/${n}.png`) : [],
		filename:
			emoteImage != ""
				? `./raw-images/${createHash("md5")
						.update(emoteImage)
						.digest("hex")}.png`
				: null,
	};
}

function parseBgPosition(pos, dim, max) {
	if (allDigitRegex.test(pos)) return parseInt(pos);

	const percentMatch = percentRegex.exec(pos);
	if (percentMatch) {
		const percent = Math.abs(parseInt(percentMatch[1]) / 100);
		return dim * percent;
	}

	const pxMatch = pxRegex.exec(pos);
	if (pxMatch) {
		const pixels = parseInt(pxMatch[1]);
		if (pixels >= 0) return pixels;

		const temp = (pixels * -1) % max;
		return temp;
	}

	throw new Error(`Invalid bg position ${pos}`);
}
