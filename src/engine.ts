import type { Game, PokerAction, Seat, SidePot, Street } from './types'

const uid = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
const copy = <T,>(value: T): T => structuredClone(value)

export const activeInHand = (seat: Seat) => seat.state !== 'folded' && seat.state !== 'sitting-out'
export const canAct = (seat: Seat) => seat.state === 'active' && seat.stack > 0
export const potTotal = (game: Game) => game.seats.reduce((sum, seat) => sum + seat.totalBet, 0)

const ordered = (seats: Seat[]) => [...seats].sort((a, b) => a.seat - b.seat)

export function nextSeat(seats: Seat[], fromSeat: number, predicate: (seat: Seat) => boolean): Seat | undefined {
  const list = ordered(seats)
  return list.find((seat) => seat.seat > fromSeat && predicate(seat)) ?? list.find(predicate)
}

function addLog(game: Game, text: string, seatId?: string) {
  game.logs.push({ id: uid(), hand: game.handNumber, street: game.street, seatId, text, createdAt: new Date().toISOString() })
}

function postBlind(game: Game, seat: Seat, amount: number, label: string) {
  const paid = Math.min(seat.stack, amount)
  seat.stack -= paid
  seat.streetBet += paid
  seat.totalBet += paid
  if (seat.stack === 0) seat.state = 'all-in'
  addLog(game, `${seat.name} · ${label} $${(paid / 100).toFixed(2)}`, seat.id)
}

export function startHand(source: Game): Game {
  const game = copy(source)
  game.seats.forEach((seat) => {
    seat.streetBet = 0
    seat.totalBet = 0
    seat.state = seat.sittingOutNextHand || seat.stack <= 0 ? 'sitting-out' : 'active'
  })
  const participants = game.seats.filter((seat) => seat.state === 'active')
  if (participants.length < 2) throw new Error('플레이 가능한 사람이 2명 이상 필요합니다.')

  const keepButton = (game.handNumber === 0 || game.repeatButtonNextHand) && game.buttonSeat !== null
    && participants.some((s) => s.seat === game.buttonSeat)
  if (keepButton) {
    // Keep the logical button for the first deal or a void-hand redeal.
  } else {
    game.buttonSeat = nextSeat(game.seats, game.buttonSeat ?? -1, (s) => s.state === 'active')!.seat
  }
  if (!game.repeatButtonNextHand) game.handNumber += 1
  game.repeatButtonNextHand = false
  game.phase = 'playing'
  game.street = 'preflop'
  game.currentBet = 0
  game.minRaise = game.bigBlind
  game.communityCardsRevealed = 0
  game.awaitingBoard = false
  game.needsAction = []
  game.lastActedBet = {}
  addLog(game, `핸드 #${game.handNumber} 시작`)

  const button = game.seats.find((s) => s.seat === game.buttonSeat)!
  const headsUp = participants.length === 2
  const smallBlind = headsUp ? button : nextSeat(game.seats, button.seat, (s) => s.state === 'active')!
  const bigBlind = nextSeat(game.seats, smallBlind.seat, (s) => s.state === 'active')!
  game.smallBlindSeat = smallBlind.seat
  game.bigBlindSeat = bigBlind.seat
  postBlind(game, smallBlind, game.smallBlind, 'SB')
  postBlind(game, bigBlind, game.bigBlind, 'BB')
  participants.filter((seat) => seat.owesEntryBlind).forEach((seat) => {
    if (seat.id !== bigBlind.id) {
      const paid = Math.min(seat.stack, Math.max(0, game.bigBlind - seat.streetBet))
      seat.stack -= paid
      seat.streetBet += paid
      seat.totalBet += paid
      if (seat.stack === 0) seat.state = 'all-in'
      addLog(game, `${seat.name} · 참가/복귀 BB 총 $${money(seat.streetBet)}`, seat.id)
    }
    seat.owesEntryBlind = false
  })
  // The nominal big blind remains the preflop bring-in even if the BB is all-in short.
  game.currentBet = game.bigBlind

  const actionable = game.seats.filter(canAct)
  if (actionable.length <= 1) {
    const lone = actionable[0]
    if (lone && lone.streetBet < game.currentBet) game.needsAction = [lone.id]
    else return toShowdown(game)
  } else {
    game.needsAction = actionable.map((seat) => seat.id)
  }
  const first = headsUp ? smallBlind : nextSeat(game.seats, bigBlind.seat, canAct)!
  game.currentActorId = game.needsAction.includes(first.id)
    ? first.id
    : nextPending(game, first.seat - 1)?.id ?? null
  return game
}

function nextPending(game: Game, fromSeat: number): Seat | undefined {
  return nextSeat(game.seats, fromSeat, (seat) => game.needsAction.includes(seat.id) && canAct(seat))
}

function toShowdown(game: Game): Game {
  game.phase = 'showdown'
  game.street = 'showdown'
  game.awaitingBoard = (game.communityCardsRevealed ?? 0) < 5
  game.currentActorId = null
  game.needsAction = []
  addLog(game, '쇼다운 · 승자를 선택하세요')
  return game
}

function nextStreet(game: Game): Game {
  const next: Record<Exclude<Street, 'showdown'>, Street> = {
    preflop: 'flop',
    flop: 'turn',
    turn: 'river',
    river: 'showdown',
  }
  if (game.street === 'showdown' || next[game.street] === 'showdown') return toShowdown(game)
  game.street = next[game.street]
  game.awaitingBoard = true
  game.currentBet = 0
  game.minRaise = game.bigBlind
  game.lastActedBet = {}
  game.seats.forEach((seat) => { seat.streetBet = 0 })
  const actionable = game.seats.filter(canAct)
  if (actionable.length <= 1) return toShowdown(game)
  game.needsAction = actionable.map((seat) => seat.id)
  const buttonSeat = game.buttonSeat ?? -1
  game.currentActorId = nextSeat(game.seats, buttonSeat, (s) => game.needsAction.includes(s.id) && canAct(s))?.id ?? null
  addLog(game, `${streetName(game.street)} 베팅 시작`)
  return game
}

export function availableActions(game: Game, seatId: string) {
  const seat = game.seats.find((s) => s.id === seatId)
  if (!seat || game.phase !== 'playing' || game.awaitingBoard || game.currentActorId !== seatId) return [] as PokerAction['type'][]
  const owing = Math.max(0, game.currentBet - seat.streetBet)
  const actions: PokerAction['type'][] = ['fold']
  if (owing === 0) actions.push('check')
  else actions.push('call')
  // With nobody left who can call, further chips would create a dry side pot.
  // The player may only resolve the outstanding wager (or fold).
  if (!game.seats.some((candidate) => candidate.id !== seat.id && canAct(candidate))) return actions
  const lastActedAt = game.lastActedBet?.[seatId]
  const canRaiseNow = lastActedAt === undefined || game.currentBet - lastActedAt >= game.minRaise
  if (seat.stack > owing && canRaiseNow) actions.push(game.currentBet === 0 ? 'bet' : 'raise')
  if (seat.streetBet + seat.stack <= game.currentBet || canRaiseNow) actions.push('all-in')
  return actions
}

export function applyAction(source: Game, action: PokerAction): Game {
  const game = copy(source)
  const actor = game.seats.find((s) => s.id === game.currentActorId)
  if (!actor || game.phase !== 'playing') throw new Error('현재 행동할 플레이어가 없습니다.')
  if (!game.needsAction.includes(actor.id)) throw new Error('이 플레이어의 차례가 아닙니다.')
  const actions = availableActions(game, actor.id)
  if (!actions.includes(action.type)) throw new Error('현재 선택할 수 없는 행동입니다.')

  const previousBet = game.currentBet
  const maxTotal = actor.streetBet + actor.stack
  let label = ''
  let fullRaise = false

  if (action.type === 'fold') {
    actor.state = 'folded'
    label = '폴드'
  } else if (action.type === 'check') {
    if (actor.streetBet !== game.currentBet) throw new Error('콜할 금액이 있어 체크할 수 없습니다.')
    label = '체크'
  } else if (action.type === 'call') {
    const paid = Math.min(actor.stack, game.currentBet - actor.streetBet)
    actor.stack -= paid
    actor.streetBet += paid
    actor.totalBet += paid
    if (actor.stack === 0) actor.state = 'all-in'
    label = actor.state === 'all-in' ? `올인 콜 $${money(paid)}` : `콜 $${money(paid)}`
  } else {
    const requestedTotal = action.type === 'all-in' ? maxTotal : action.total
    if (requestedTotal <= actor.streetBet || requestedTotal > maxTotal) throw new Error('베팅 금액을 확인해주세요.')
    if ((action.type === 'bet' || action.type === 'raise') && requestedTotal <= previousBet) {
      throw new Error('현재 베팅보다 큰 금액이어야 합니다.')
    }
    const increase = requestedTotal - previousBet
    const isAllIn = requestedTotal === maxTotal
    if (requestedTotal > previousBet && increase < game.minRaise && !isAllIn) {
      throw new Error(`최소 총 베팅은 $${money(previousBet + game.minRaise)}입니다.`)
    }
    const paid = requestedTotal - actor.streetBet
    actor.stack -= paid
    actor.streetBet = requestedTotal
    actor.totalBet += paid
    if (actor.stack === 0) actor.state = 'all-in'
    if (requestedTotal > previousBet) {
      game.currentBet = requestedTotal
      fullRaise = previousBet === 0 ? requestedTotal >= game.bigBlind : increase >= game.minRaise
      if (fullRaise) game.minRaise = previousBet === 0 ? requestedTotal : increase
    }
    label = `${actor.state === 'all-in' ? '올인' : previousBet === 0 ? '벳' : '레이즈'} · 총 $${money(requestedTotal)}`
  }
  addLog(game, `${actor.name} · ${label}`, actor.id)

  game.needsAction = game.needsAction.filter((id) => id !== actor.id)
  game.lastActedBet ??= {}
  game.lastActedBet[actor.id] = game.currentBet
  if (fullRaise) {
    game.needsAction = game.seats.filter((s) => s.id !== actor.id && canAct(s)).map((s) => s.id)
  } else {
    if (game.currentBet > previousBet) {
      game.seats.filter((s) => s.id !== actor.id && canAct(s) && s.streetBet < game.currentBet)
        .forEach((s) => { if (!game.needsAction.includes(s.id)) game.needsAction.push(s.id) })
    }
  }

  const contenders = game.seats.filter(activeInHand)
  if (contenders.length === 1) return awardFoldWin(game, contenders[0])
  game.needsAction = game.needsAction.filter((id) => game.seats.some((s) => s.id === id && canAct(s)))
  if (game.needsAction.length === 0) return nextStreet(game)
  game.currentActorId = nextPending(game, actor.seat)?.id ?? null
  return game
}

export function confirmBoardDealt(source: Game): Game {
  const game = copy(source)
  if (!game.awaitingBoard) throw new Error('지금은 공용 카드를 펼칠 단계가 아닙니다.')
  const target = game.phase === 'showdown' || game.street === 'river' ? 5 : game.street === 'turn' ? 4 : 3
  const previous = game.communityCardsRevealed ?? 0
  game.communityCardsRevealed = target
  game.awaitingBoard = false
  addLog(game, `공용 카드 ${target - previous}장 공개 · 총 ${target}장`)
  return game
}

export function voidCurrentHand(source: Game): Game {
  const game = copy(source)
  if (game.phase !== 'playing' && game.phase !== 'showdown') throw new Error('진행 중인 핸드가 없습니다.')
  const returned = potTotal(game)
  addLog(game, `핸드 #${game.handNumber} 무효 · 베팅 $${money(returned)} 전액 반환`)
  game.seats.forEach((seat) => {
    seat.stack += seat.totalBet
    seat.totalBet = 0
    seat.streetBet = 0
    seat.state = seat.sittingOutNextHand || seat.stack <= 0 ? 'sitting-out' : 'active'
  })
  game.phase = 'between-hands'
  game.street = 'preflop'
  game.currentActorId = null
  game.currentBet = 0
  game.minRaise = game.bigBlind
  game.needsAction = []
  game.lastActedBet = {}
  game.communityCardsRevealed = 0
  game.awaitingBoard = false
  game.repeatButtonNextHand = true
  return game
}

function awardFoldWin(game: Game, winner: Seat): Game {
  const amount = potTotal(game)
  winner.stack += amount
  game.seats.filter((seat) => seat.state !== 'sitting-out').forEach((seat) => {
    seat.handsPlayed = (seat.handsPlayed ?? 0) + 1
    if (seat.id === winner.id) seat.handsWon = (seat.handsWon ?? 0) + 1
  })
  game.seats.forEach((s) => { s.totalBet = 0; s.streetBet = 0 })
  game.phase = 'between-hands'
  game.street = 'showdown'
  game.currentActorId = null
  game.needsAction = []
  addLog(game, `${winner.name} · 폴드 승리 +$${money(amount)}`, winner.id)
  return game
}

export function buildSidePots(game: Game): SidePot[] {
  const levels = [...new Set(game.seats.map((s) => s.totalBet).filter((n) => n > 0))].sort((a, b) => a - b)
  let previous = 0
  return levels.map((level, index) => {
    const contributors = game.seats.filter((s) => s.totalBet >= level)
    const eligible = contributors.filter(activeInHand)
    const amount = (level - previous) * contributors.length
    previous = level
    return {
      id: `pot-${index}`,
      amount,
      eligibleSeatIds: eligible.map((s) => s.id),
      automatic: eligible.length === 1,
      uncalledReturn: contributors.length === 1 && eligible.length === 1,
    }
  }).filter((pot) => pot.amount > 0)
}

export function settleShowdown(source: Game, selections: Record<string, string[]>): Game {
  const game = copy(source)
  if (game.phase !== 'showdown') throw new Error('쇼다운 상태가 아닙니다.')
  if (game.awaitingBoard || (game.communityCardsRevealed ?? 5) < 5) throw new Error('공용 카드 5장을 모두 펼친 뒤 승자를 선택해주세요.')
  const pots = buildSidePots(game)
  const handWinnerIds = new Set<string>()
  for (const pot of pots) {
    const winners = pot.automatic ? pot.eligibleSeatIds : selections[pot.id] ?? []
    if (winners.length === 0 || winners.some((id) => !pot.eligibleSeatIds.includes(id))) {
      throw new Error('각 팟의 승자를 올바르게 선택해주세요.')
    }
    const share = Math.floor(pot.amount / winners.length)
    let remainder = pot.amount - share * winners.length
    const clockwise = ordered(game.seats)
    const buttonIndex = clockwise.findIndex((s) => s.seat === game.buttonSeat)
    const awardOrder = [...clockwise.slice(buttonIndex + 1), ...clockwise.slice(0, buttonIndex + 1)]
    const winnerSeats = winners.map((id) => game.seats.find((s) => s.id === id)!)
      .sort((a, b) => awardOrder.findIndex((s) => s.id === a.id) - awardOrder.findIndex((s) => s.id === b.id))
    winnerSeats.forEach((seat) => {
      if (!pot.uncalledReturn) handWinnerIds.add(seat.id)
      const award = share + (remainder > 0 ? 1 : 0)
      if (remainder > 0) remainder -= 1
      seat.stack += award
      addLog(game, `${seat.name} · ${pot.uncalledReturn ? '콜되지 않은 베팅 반환' : pot.id === 'pot-0' ? '메인 팟' : '사이드팟'} +$${money(award)}`, seat.id)
    })
  }
  handWinnerIds.forEach((id) => {
    const seat = game.seats.find((candidate) => candidate.id === id)
    if (seat) seat.handsWon = (seat.handsWon ?? 0) + 1
  })
  game.seats.filter((seat) => seat.state !== 'sitting-out').forEach((seat) => {
    seat.handsPlayed = (seat.handsPlayed ?? 0) + 1
  })
  game.seats.forEach((s) => { s.totalBet = 0; s.streetBet = 0 })
  game.phase = 'between-hands'
  game.currentActorId = null
  game.needsAction = []
  return game
}

export function streetName(street: Street) {
  return ({ preflop: '프리플랍', flop: '플랍', turn: '턴', river: '리버', showdown: '쇼다운' } as const)[street]
}

export function money(cents: number) {
  return (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function parseMoney(value: string) {
  const number = Number(value.replace(/,/g, ''))
  return Number.isFinite(number) ? Math.round(number * 100) : 0
}
