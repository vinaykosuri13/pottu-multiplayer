const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();
const suits = ['♠', '♥', '♦', '♣'];
const ranks = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const seatNames = ['P1', 'P2', 'P3', 'P4'];

function deck() { return suits.flatMap(s => ranks.map((r, i) => ({ id: `${s}${r}`, suit: s, rank: r, value: i }))); }
function shuffle(cards) { for (let i=cards.length-1;i>0;i--) { const j=Math.floor(Math.random()*(i+1)); [cards[i],cards[j]]=[cards[j],cards[i]]; } return cards; }
function roomCode() { let c; do c = Math.random().toString(36).slice(2,6).toUpperCase(); while (rooms.has(c)); return c; }
function publicState(room) {
  return {
    code: room.code, phase: room.phase, dealer: room.dealer, turn: room.turn, leader: room.leader,
    leadSuit: room.leadSuit, cheppudu: room.cheppudu, pottu: room.pottu, tricks: room.tricks,
    players: room.players.map((p, i) => p && ({ name: p.name, seat: seatNames[i], cardCount: p.hand.length })),
    table: room.table, p3Revealed: room.p3Revealed, openPlayer: room.p3Revealed ? (room.dealer+2)%4 : null, message: room.message,
    targetScore: 100, scores: room.scores, roundResult: room.roundResult, roundNumber: room.roundNumber,
    bidStage: room.bidStage, multiplier: room.multiplier, bidNotice: room.bidNotice, gameCalled: room.gameCalled,
    lastWinner: room.lastWinner
  };
}
function emitRoom(room) {
  room.players.forEach((p, seat) => {
    if (!p) return;
    const state = publicState(room);
    state.you = seat;
    state.hand = p.hand;
    // The dealer controls the player opposite them; that hand stays public after the first lead.
    const openSeat=(room.dealer+2)%4;
    state.openHand = room.p3Revealed && room.players[openSeat] ? room.players[openSeat].hand : [];
    io.to(p.id).emit('state', state);
  });
}
function startRound(room) {
  const d = shuffle(deck());
  room.players.forEach((p,i) => { p.hand=d.slice(i*13, i*13+13); });
  room.phase='cheppudu'; room.turn=room.dealer; room.leader=(room.dealer+1)%4; room.leadSuit=null;
  room.cheppudu=null; room.pottu=0; room.tricks=[0,0,0,0]; room.table=[]; room.roundNumber=(room.roundNumber||0)+1;
  room.bidStage=null; room.multiplier=1; room.bidNotice=null; room.gameCalled=false; room.lastWinner=null;
  room.p3Revealed=false; room.message=`${seatNames[room.dealer]}: choose Cheppudu suit`;
}
function finishTrick(room) {
  const lead = room.leadSuit;
  const trumps = room.table.filter(x => x.card.suit === room.cheppudu);
  const playable = trumps.length ? trumps : room.table.filter(x => x.card.suit === lead);
  playable.sort((a,b) => b.card.value-a.card.value);
  const winner = playable[0].seat;
  room.tricks[winner]++; room.pottu++; room.table=[]; room.leadSuit=null; room.leader=winner; room.turn=winner;
  if (room.pottu === 13) {
    const team13=room.tricks[0]+room.tricks[2], team24=room.tricks[1]+room.tricks[3];
    const winningTeam=team13>=team24 ? 0 : 1;
    const winningPottus=Math.max(team13,team24), lead=winningPottus-6;
    const values={'♠':10,'♥':8,'♦':6,'♣':4,DIGUDU:12};
    const roundPoints=room.gameCalled ? 100 : lead*values[room.cheppudu]*room.multiplier;
    if(room.gameCalled) room.scores[winningTeam]=100; else room.scores[winningTeam]+=roundPoints;
    room.roundResult={team13,team24,winningTeam,lead,roundPoints,gameWinner:room.gameCalled||room.scores[winningTeam]>=100};
    room.phase='complete'; room.message=room.roundResult.gameWinner ? `Game complete: Team ${winningTeam===0?'P1 & P3':'P2 & P4'} reached 100 points.` : '13 Pottus complete. Score table is ready.';
  } else room.message=`${seatNames[winner]} won Pottu ${room.pottu}. ${seatNames[winner]} leads next.`;
  room.lastWinner=winner;
}
io.on('connection', socket => {
  socket.on('createRoom', ({name}, ack) => {
    const code=roomCode(); const room={code,players:[{id:socket.id,name:name||'Player 1',hand:[]}],dealer:0,phase:'lobby',turn:0,leader:1,leadSuit:null,cheppudu:null,pottu:0,tricks:[0,0,0,0],table:[],p3Revealed:false,scores:[0,0],roundResult:null,message:'Waiting for 3 more players…'};
    rooms.set(code,room); socket.join(code); ack({ok:true,code,seat:0}); emitRoom(room);
  });
  socket.on('joinRoom', ({code,name}, ack) => {
    const room=rooms.get((code||'').toUpperCase()); if (!room) return ack({ok:false,error:'Room not found'});
    if (room.phase !== 'lobby') return ack({ok:false,error:'This game has already started'});
    if (room.players.length >= 4) return ack({ok:false,error:'Room is full'});
    const seat=room.players.length; room.players.push({id:socket.id,name:name||seatNames[seat],hand:[]}); socket.join(room.code); ack({ok:true,code:room.code,seat});
    if(room.players.length===4) { startRound(room); } else room.message=`Waiting for ${4-room.players.length} more player(s)…`;
    emitRoom(room);
  });
  socket.on('chooseCheppudu', ({suit}) => {
    const room=[...rooms.values()].find(r=>r.players.some(p=>p&&p.id===socket.id)); if(!room || room.phase!=='cheppudu') return;
    const seat=room.players.findIndex(p=>p.id===socket.id); if(seat!==room.dealer || (![...suits,'DIGUDU'].includes(suit))) return;
    room.cheppudu=suit; room.phase='playing'; room.turn=room.leader; room.bidStage='double'; room.message=suit==='DIGUDU' ? `Digudu selected — no Cheppudu suit. ${seatNames[room.turn]} plays first.` : `Cheppudu: ${suit}. ${seatNames[room.turn]} plays first.`; emitRoom(room);
  });
  socket.on('bid', ({type}) => {
    const room=[...rooms.values()].find(r=>r.players.some(p=>p&&p.id===socket.id)); if(!room || room.phase!=='playing' || room.pottu!==0) return;
    const seat=room.players.findIndex(p=>p.id===socket.id), dealerTeam=room.dealer%2, ownTeam=seat%2;
    if(type==='double' && room.bidStage==='double' && ownTeam!==dealerTeam) { room.multiplier=2; room.bidStage='triple'; room.bidNotice=`${seatNames[seat]} called DOUBLE — score ×2`; }
    else if(type==='triple' && room.bidStage==='triple' && ownTeam===dealerTeam) { room.multiplier=4; room.bidStage='game'; room.bidNotice=`${seatNames[seat]} called TRIPLE — score ×4`; }
    else if(type==='game' && room.bidStage==='game' && ownTeam!==dealerTeam) { room.gameCalled=true; room.bidStage='none'; room.bidNotice=`${seatNames[seat]} called GAME — most Pottus wins the 100-point match`; }
    else return;
    emitRoom(room);
  });
  socket.on('playCard', ({cardId}) => {
    const room=[...rooms.values()].find(r=>r.players.some(p=>p&&p.id===socket.id)); if(!room || room.phase!=='playing') return;
    const seat=room.players.findIndex(p=>p.id===socket.id);
    // The dealer controls the player opposite them, once that hand is revealed.
    const openSeat=(room.dealer+2)%4;
    const permittedSeats=room.turn===openSeat ? [room.dealer] : [room.turn];
    if(!permittedSeats.includes(seat)) return;
    const hand=room.players[room.turn].hand; const index=hand.findIndex(c=>c.id===cardId); if(index<0) return;
    const card=hand[index]; if(room.leadSuit && card.suit!==room.leadSuit && hand.some(c=>c.suit===room.leadSuit)) { socket.emit('notice','Follow the lead suit when you can.'); return; }
    hand.splice(index,1); room.table.push({seat:room.turn,card});
    if(!room.leadSuit) { room.leadSuit=card.suit; if(!room.p3Revealed) room.p3Revealed=true; }
    if(room.pottu===0) {
      if(room.table.length===1 && room.bidStage==='double') room.bidStage='none';
      if(room.table.length===2 && room.bidStage==='triple') room.bidStage='none';
      if(room.table.length===2 && room.multiplier===4) room.bidStage='game';
      if(room.table.length===3 && room.bidStage==='game') room.bidStage='none';
    }
    if(room.table.length===4) finishTrick(room); else { room.turn=(room.turn+1)%4; room.message=`${seatNames[room.turn]}'s turn`; }
    emitRoom(room);
  });
  socket.on('nextRound', () => {
    const room=[...rooms.values()].find(r=>r.players.some(p=>p&&p.id===socket.id)); if(!room || room.phase!=='complete') return;
    const seat=room.players.findIndex(p=>p.id===socket.id); if(seat!==room.dealer) return;
    room.dealer=(room.dealer+1)%4; room.roundResult=null; startRound(room); emitRoom(room);
  });
  socket.on('reorderHand', ({hand}) => { const room=[...rooms.values()].find(r=>r.players.some(p=>p&&p.id===socket.id)); if(!room) return; const p=room.players.find(p=>p.id===socket.id); if(Array.isArray(hand) && hand.length===p.hand.length && new Set(hand).size===hand.length) { const map=new Map(p.hand.map(c=>[c.id,c])); if(hand.every(id=>map.has(id))) { p.hand=hand.map(id=>map.get(id)); emitRoom(room); } } });
  socket.on('disconnect', () => { /* seats remain reserved so a reconnect does not reshuffle a live round */ });
});
server.listen(process.env.PORT || 3000, () => console.log('Pottu server running on http://localhost:3000'));
