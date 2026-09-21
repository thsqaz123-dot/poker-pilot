import type { Game, PersistedState } from './types'

const KEY = 'poker-pilot:v1'
const EMPTY: PersistedState = { profiles: [], game: null, transactions: [], archives: [] }

export function loadState(): PersistedState {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return EMPTY
    const parsed = { ...EMPTY, ...JSON.parse(raw) } as PersistedState
    return { ...parsed, game: parsed.game ? migrateGame(parsed.game) : null }
  } catch {
    return EMPTY
  }
}

const SEAT_SLOTS: Record<number, number[]> = {
  2: [0, 3],
  3: [0, 2, 4],
  4: [0, 2, 3, 5],
  5: [0, 1, 2, 4, 5],
  6: [0, 1, 2, 3, 4, 5],
}

function migrateGame(source: Game): Game {
  const game = structuredClone(source)
  const legacyButton = game.buttonSeat ?? game.dealerSeat ?? null
  if (game.layoutVersion !== 2 && game.seats.length >= 2) {
    const seats = [...game.seats].sort((a, b) => a.seat - b.seat)
    const slots = SEAT_SLOTS[seats.length] ?? SEAT_SLOTS[6]
    const mapping = new Map(seats.map((seat, index) => [seat.seat, slots[index]]))
    game.seats = game.seats.map((seat) => ({ ...seat, seat: mapping.get(seat.seat) ?? seat.seat }))
    game.buttonSeat = legacyButton === null ? null : mapping.get(legacyButton) ?? legacyButton
    if (game.smallBlindSeat != null) game.smallBlindSeat = mapping.get(game.smallBlindSeat) ?? game.smallBlindSeat
    if (game.bigBlindSeat != null) game.bigBlindSeat = mapping.get(game.bigBlindSeat) ?? game.bigBlindSeat
  } else {
    game.buttonSeat = legacyButton
  }
  game.layoutVersion = 2
  game.lastActedBet ??= Object.fromEntries((game.actedSinceFullRaise ?? []).map((id) => [id, game.currentBet]))
  game.seats = game.seats.map((seat) => ({
    ...seat,
    buyInTotal: seat.buyInTotal ?? seat.stack + seat.totalBet,
    handsPlayed: seat.handsPlayed ?? 0,
    handsWon: seat.handsWon ?? 0,
  }))
  game.participatingProfileIds ??= [...new Set([...game.seats, ...(game.departedSeats ?? [])].map((seat) => seat.profileId))]
  game.departedSeats ??= []
  return game
}

export function saveState(state: PersistedState) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state))
  } catch {
    // Safari private browsing or a full storage quota must not break gameplay.
  }
}
