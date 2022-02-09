require('dotenv').config();
const knex = require('./util/db-connection');
const { Game, MoveDirection, SpriteDirectionEnum_ENUM } = require("@gathertown/gather-game-client");
const cron = require('node-cron');
const { format } = require('date-fns');
const axios = require('axios');
global.WebSocket = require('isomorphic-ws');

console.log('current system date: ' + (new Date()).toTimeString());

// -- block to provide a fake interface and avoid heroku errors
const http = require('http');
http.createServer(function (request, response) {
	response.writeHead(200, {'Content-Type': 'text/plain'});
	response.end('hello', 'utf-8');
}).listen(process.env.PORT || 5000);
// --

// setup
let started = false,
	npcStartTime = new Date(),
	followingPlayerId = null,
	followingPlayerIntervalId = null,
	lastFollowingPosition = {
		x: 0,
		y: 0,
		count: 0
	},
	availableCommands = "\n - up\n - down\n - left\n - right\n - confetti\n - dance\n - follow\n - ghost\n - stop\n - teleport here\n - today birthdays\n - scare\n - scream";


if(process.env.ENABLE_ANIME_QUOTES !== false) {
	availableCommands += "\n - anime quote";
}
if(process.env.ENABLE_INSPIRATIONAL_QUOTES !== false) {
	availableCommands += "\n - inspire me";
}
if(process.env.ENABLE_JOKES !== false) {
	availableCommands += "\n - joke\n - joke containing ABCD (search text)";
}
if(process.env.ENABLE_HOROSCOPE !== false) {
	availableCommands += "\n - horoscope";
}
if(process.env.ENABLE_NASA !== false) {
	availableCommands += "\n - nasa";
}
if(process.env.ENABLE_RANDOM_FACTS !== false) {
	availableCommands += "\n - random fact";
}

const game = new Game(process.env.GATHER_SPACE_ID, () => Promise.resolve({apiKey: process.env.GATHER_API_KEY}));

async function start() {
	// listen for joining players
	game.subscribeToEvent('playerJoins', (data, _context) => {
		if(_context.playerId === game.engine.clientUid) {
			return;
		}
		setTimeout(async () => {
			let today = format(new Date(), 'yyyy-MM-dd');
			let person = await knex('person')
				.where({player_id: _context.playerId})
				.first();
			if (!person) {
				let player = game.getPlayer(_context.playerId);
				person = await knex('person')
					.insert({player_id: _context.playerId, name: player.name})
					.returning('*');
				person = person[0];
				game.chat(person.player_id, [], '', 'Welcome, ' + person.name + '!');
			}
			else if(person.last_greeting === null || format(Date.parse(person.last_greeting), 'yyyy-MM-dd') !== today || ((new Date()) - npcStartTime) > 5*60*1000) { //check if hasn't greeted the person before or if is running for at least 5 minutes (avoids greeting everytime the npc starts)
				game.chat(person.player_id, [], '', getGreeting(person.name));
				await knex('person')
					.update({last_greeting: today, updated_at: knex.fn.now()})
					.where({player_id: person.player_id});
			}
			if(person.birthday === null) {
				game.chat(person.player_id, [], '', "Can you tell me when is your birthday?\nSend me a message with the format: DD/MM");
			}
			else if(format(new Date(), 'dd/MM') === person.birthday) {
				game.chat(person.player_id, [], '', 'Happy birthday! 🥳🎉🎈');
			}
		}, 2000);
	});

	// listen for chats
	game.subscribeToEvent('playerChats', async (data, _context) => {
		// console.log(data);
		const message = data.playerChats;
		// console.log(message);
		if(message.senderId === game.engine.clientUid) {
			return;
		}
		switch (message.contents.toLowerCase()) {
			case 'up':
				game.move(MoveDirection.Up);
				break;
			case 'down':
				game.move(MoveDirection.Down);
				break;
			case 'left':
				game.move(MoveDirection.Left);
				break;
			case 'right':
				game.move(MoveDirection.Right);
				break;
			case 'confetti':
				game.shootConfetti();
				break;
			case 'dance':
				game.move(MoveDirection.Dance);
				break;
			case 'follow':
				game.chat(message.senderId, [], '', 'Right behind you!');
				follow(message.senderId);
				break;
			case 'ghost':
				game.ghost(1);
				break;
			case 'stop':
				game.move(MoveDirection.Down, true);
				stopFollowing();
				game.ghost(0);
				break;
			case 'teleport here':
				game.chat(message.senderId, [], '', 'On my way!');
				let playerFront = getPlayerFront(message.senderId);
				game.teleport('', playerFront.x, playerFront.y);
				game.move(playerFront.faceDirection, true);
				break;
			case 'today birthdays':
				game.chat(message.senderId, [], '', await todayBirthdays());
				break;
			case 'scare':
				game.chat('GLOBAL_CHAT', [], '', 'BUUUUUU! 👻');
				break;
			case 'scream':
				game.chat('GLOBAL_CHAT', [], '', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA 😱');
				break;
			case 'anime quote':
				if(process.env.ENABLE_ANIME_QUOTES !== false) {
					animeQuote(message.senderId);
					break;
				}
			case 'inspire me':
				if(process.env.ENABLE_INSPIRATIONAL_QUOTES !== false) {
					inspireMe(message.senderId);
					break;
				}
			case 'joke':
				if(process.env.ENABLE_JOKES !== false) {
					joke(message.senderId);
					break;
				}
			case 'horoscope':
				if(process.env.ENABLE_HOROSCOPE !== false) {
					await horoscopeOfTheDay(message.senderId);
					break;
				}
			case 'nasa':
				if(process.env.ENABLE_NASA !== false) {
					nasaPictureOfTheDay(message.senderId);
					break;
				}
			case 'random fact':
				if(process.env.ENABLE_RANDOM_FACTS !== false) {
					randomFact(message.senderId);
					break;
				}
			default:
				if(process.env.ENABLE_JOKES !== false && message.contents.toLowerCase().startsWith('joke containing ')) {
					joke(message.senderId, message.contents.toLowerCase().replace('joke containing ', ''));
					break;
				}
				if (message.messageType === 'DM') {
					if(isValidBirthday(message.contents)) {
						let person = await knex('person')
							.update({birthday: message.contents, updated_at: knex.fn.now()})
							.where({player_id: message.senderId})
							.returning('*');
						game.chat(message.senderId, [], '', 'Birthday noted!');
						if(format(new Date(), 'dd/MM') === person.birthday) {
							game.chat('GLOBAL_CHAT', [], '', "Hey everyone! Today's " + person.name + "'s birthday! 🥳🎉🎈");
						}
					}
					else {
						let reply = 'What do you want? Available commands:' + availableCommands;
						game.chat(message.senderId, [], '', reply);
					}
				}
		}
	});

	//daily messages
	cron.schedule('30 9 * * *', async () => { //9h30
		let birthdays = await todayBirthdays(true);
		if (birthdays.length > 0) {
			game.chat('GLOBAL_CHAT', [], '', birthdays);
		}
	});
}

function getPlayerBack(playerId) {
	let player = game.getPlayer(playerId);
	if (player.direction === SpriteDirectionEnum_ENUM.Up || player.direction === SpriteDirectionEnum_ENUM.UpAlt) {
		return {
			player: player,
			x: player.x,
			y: player.y + 1,
			faceDirection: MoveDirection.Up
		};
	}
	if (player.direction === SpriteDirectionEnum_ENUM.Left || player.direction === SpriteDirectionEnum_ENUM.LeftAlt) {
		return {
			player: player,
			x: player.x + 1,
			y: player.y,
			faceDirection: MoveDirection.Left
		};
	}
	if (player.direction === SpriteDirectionEnum_ENUM.Right || player.direction === SpriteDirectionEnum_ENUM.RightAlt) {
		return {
			player: player,
			x: player.x - 1,
			y: player.y,
			faceDirection: MoveDirection.Right
		};
	}
	return {
		player: player,
		x: player.x,
		y: player.y - 1,
		faceDirection: MoveDirection.Down
	};
}

function getPlayerFront(playerId) {
	let player = game.getPlayer(playerId);
	if (player.direction === SpriteDirectionEnum_ENUM.Up || player.direction === SpriteDirectionEnum_ENUM.UpAlt) {
		return {
			player: player,
			x: player.x,
			y: player.y - 1,
			faceDirection: MoveDirection.Down
		};
	}
	if (player.direction === SpriteDirectionEnum_ENUM.Left || player.direction === SpriteDirectionEnum_ENUM.LeftAlt) {
		return {
			player: player,
			x: player.x - 1,
			y: player.y,
			faceDirection: MoveDirection.Right
		};
	}
	if (player.direction === SpriteDirectionEnum_ENUM.Right || player.direction === SpriteDirectionEnum_ENUM.RightAlt) {
		return {
			player: player,
			x: player.x + 1,
			y: player.y,
			faceDirection: MoveDirection.Left
		};
	}
	return {
		player: player,
		x: player.x,
		y: player.y + 1,
		faceDirection: MoveDirection.Up
	};
}

function isDancing(direction) {
	return direction === SpriteDirectionEnum_ENUM.Dance1 || direction === SpriteDirectionEnum_ENUM.Dance2 || direction === SpriteDirectionEnum_ENUM.Dance3 || direction === SpriteDirectionEnum_ENUM.Dance4;
}

function follow(playerId) {
	if (followingPlayerIntervalId !== null) {
		stopFollowing();
	}
	followingPlayerId = playerId;
	let playerBack = getPlayerBack(playerId);
	game.teleport('', playerBack.x, playerBack.y);
	game.move(playerBack.faceDirection, true);
	if (isDancing(playerBack.player.direction)) {
		game.move(MoveDirection.Dance);
	}
	lastFollowingPosition = {
		x: playerBack.x,
		y: playerBack.y,
		count: 0
	};
	followingPlayerIntervalId = setInterval(() => {
		if (!game.engine.clientUid || followingPlayerId === null || !game.getPlayer(followingPlayerId)) {
			stopFollowing();
			return;
		}
		let playerBack = getPlayerBack(followingPlayerId),
			npcPlayer = game.getPlayer(game.engine.clientUid),
			isInPosition = true;
		if (!playerBack.player.isSignedIn) {
			stopFollowing();
			return;
		}
		if (playerBack.x !== npcPlayer.x) {
			game.move(playerBack.x < npcPlayer.x ? MoveDirection.Left : MoveDirection.Right);
			isInPosition = false;
		}
		if (playerBack.y !== npcPlayer.y) {
			game.move(playerBack.y < npcPlayer.y ? MoveDirection.Up : MoveDirection.Down);
			isInPosition = false;
		}
		if (isInPosition) {
			if (isDancing(playerBack.player.direction)) {
				game.move(MoveDirection.Dance);
			} else if (playerBack.player.direction !== npcPlayer.direction) {
				game.move(playerBack.faceDirection, true);
			}
		} else if (lastFollowingPosition.x === npcPlayer.x && lastFollowingPosition.y === npcPlayer.y) {
			lastFollowingPosition.count++;
			if (lastFollowingPosition.count >= 8) {
				lastFollowingPosition = {
					x: playerBack.x,
					y: playerBack.y,
					count: 0
				};
				game.teleport('', playerBack.x, playerBack.y);
			}
		} else {
			lastFollowingPosition = {
				x: playerBack.x,
				y: playerBack.y,
				count: 0
			};
		}
	}, 180);
}

function stopFollowing() {
	if(followingPlayerIntervalId !== null) {
		clearInterval(followingPlayerIntervalId);
	}
	followingPlayerIntervalId = null;
	followingPlayerId = null;
}

function isValidBirthday(date) {
	date = date.replace(/[^\d\/]/g, '').split('/').reverse().join('-') + '-' + '2000';
	return isDate(date);
}

function isDate(date) {
	return date.length === 10 && (new Date(date) !== 'Invalid Date') && !isNaN(new Date(date));
}

async function todayBirthdays(returnEmpty = false) {
	let people = await knex('person')
		.where({birthday: format(new Date(), 'dd/MM'), active: true})
		.select('name');

	if(people.length === 0) {
		return returnEmpty ? '' : 'No birthdays today... :(';
	}

	let birthdays = '';
	people.forEach((person) => {
		birthdays += (birthdays.length > 0 ? ', ' : '') + person.name
	});
	return "Today's birthdays: " + birthdays + "\n\nCongratulations! 🥳🎉🎈";
}

function inspireMe(playerId) {
	axios.get('https://zenquotes.io/api/random')
		.then(response => {
			game.chat(playerId, [], '', "\"" + response.data[0].q + "\"\n- " + response.data[0].a);
		})
		.catch(error => {
			game.chat(playerId, [], '', "Error getting a inspirational quote: " + error.message);
		});
}

function animeQuote(playerId) {
	axios.get('https://animechan.vercel.app/api/random')
		.then(response => {
			game.chat(playerId, [], '', "\"" + response.data.quote + "\"\n- " + response.data.character + " (" + response.data.anime + ")");
		})
		.catch(error => {
			game.chat(playerId, [], '', "Error getting a anime quote: " + error.message);
		});
}

function joke(playerId, contains = '') {
	let nsfwEnabled = process.env.ENABLE_NSFW_JOKES;
	axios.get('https://v2.jokeapi.dev/joke/Any', {params: {contains: contains, blacklistFlags: (nsfwEnabled ? '' : 'nsfw,racist,sexist,explicit,political,religious')}})
		.then(response => {
			if(response.data.error) {
				game.chat(playerId, [], '', response.data.message);
			}
			else if(response.data.type === 'twopart') {
				game.chat(playerId, [], '', response.data.setup);
				setTimeout(() => {
					game.chat(playerId, [], '', response.data.delivery);
				}, 2000);
			}
			else {
				game.chat(playerId, [], '', response.data.joke);
			}
		})
		.catch(error => {
			game.chat(playerId, [], '', "Error getting a joke: " + error.message);
		});
}

function randomFact(playerId) {
	axios.get('https://uselessfacts.jsph.pl/random.json?language=en')
		.then(response => {
			game.chat(playerId, [], '', response.data.text);
		})
		.catch(error => {
			game.chat(playerId, [], '', "Error getting a random fact: " + error.message);
		});
}

function findSign(birthday) {
	const days = [21, 20, 21, 21, 22, 22, 23, 24, 24, 24, 23, 22],
		signs = ['aquarius', 'pisces', 'aries', 'taurus', 'gemini', 'cancer', 'leo', 'virgo', 'libra', 'scorpio', 'sagittarius', 'capricorn'];

	let dateParts = birthday.split('/'),
		day = parseInt(dateParts[0]),
		month = parseInt(dateParts[1]) - 1;

	if(month == 0 && day <= 20) {
		month = 11;
	}
	else if(day < days[month]) {
		month--;
	}
	return signs[month];
}

async function horoscopeOfTheDay(playerId) {
	let person = await knex('person')
		.where({player_id: playerId})
		.first();

	if(!person || person.birthday === null) {
		game.chat(playerId, [], '', "Sorry, but I don't know your birthday yet...\nSend me a message with your birthday using the format: DD/MM");
		return;
	}
	let sign = findSign(person.birthday);
	axios.post('https://aztro.sameerkumar.website/?sign=' + sign + '&day=today')
		.then(response => {
			game.chat(playerId, [], '', "Today's horoscope for " + sign +":\n" + response.data.description + "\nCompatibility: " + response.data.compatibility + "\nMood: " + response.data.mood + "\nColor: " + response.data.color + "\nLucky number: " + response.data.lucky_number + "\nLucky time: " + response.data.lucky_time);
		})
		.catch(error => {
			game.chat(playerId, [], '', "Error getting a horoscope: " + error.message);
		});
}

function nasaPictureOfTheDay(playerId) {
	if(process.env.NASA_API_KEY === undefined) {
		game.chat(playerId, [], '', "NASA's api key is not available... :(");
		return;
	}
	axios.get('https://api.nasa.gov/planetary/apod?api_key=' + process.env.NASA_API_KEY)
		.then(response => {
			game.chat(playerId, [], '', response.data.url + "\n\n" + response.data.explanation);
		})
		.catch(error => {
			game.chat(playerId, [], '', "Error getting NASA's picture of the day: " + error.message);
		});
}

function getGreeting(name) {
	let greetings = ['Hello, ' + name + '!', 'Howdy, ' + name + '!', 'Nice to see you, ' + name + '!', 'How are you, ' + name + '?'];
	let currentHour = (new Date()).getHours();
	if (currentHour < 12) {
		greetings.push(
			'Good morning, ' + name + '!',
			'Rise and shine, ' + name + '!',
			'Have a great day, ' + name + '!',
			'Good day to you, ' + name + '!',
			"Isn't it a beautiful day today, " + name + '?'
		);
	}
	else if (currentHour < 18) {
		greetings.push(
			'Good afternoon, ' + name + '!'
		);
	}
	else {
		greetings.push(
			'Good evening, ' + name + '!',
			'What a pleasant evening, right ' + name + '?'
		);
	}
	return greetings[Math.floor(Math.random()*greetings.length)];
}

game.connect();
game.subscribeToConnection(async (connected) => {
	console.log('connected?', connected);

	let respawned = false;
	let initIntervalId = setInterval(async () => {
		if(game.engine.clientUid) {
			if(!respawned && !game.players[game.engine.clientUid]) {
				game.respawn();
				respawned = true;
			}
			else if(game.players[game.engine.clientUid]) {
				clearInterval(initIntervalId);

				let npc = await knex('person')
					.where({player_id: game.engine.clientUid})
					.first();
				if (!npc) {
					let player = game.getPlayer(game.engine.clientUid);
					await knex('person')
						.insert({player_id: game.engine.clientUid, name: player.name, is_npc: true})
						.returning('*');
				}
				else if(!npc.is_npc) {
					await knex('person')
						.update({is_npc: true, updated_at: knex.fn.now()})
						.where({player_id: game.engine.clientUid})
						.returning('*');
				}

				if(respawned) {
					let map = game.completeMaps[game.getStats().currentMap],
						searching = true;
					while(searching) {
						let position = map.floors[Math.floor(Math.random()*map.floors.length)];
						if(!map.collisions[position.y][position.x]) {
							game.teleport('', position.x, position.y);
							searching = false;
						}
					}
				}
				if(!started) {
					started = true;
					await start();
				}
			}
		}
	}, 100);
});