const botStates = new Map();
const infantryCategories = ["infantry", "guardsInfantry", "militiaInfantry"];
const cavalryCategories = ["scoutCavalry", "lightCavalry", "midCavalry", "heavyCavalry"];
const engagementRange = 200;
const mopUpPowerDifference = 0.1;
const mopUpAdjacentInfantryPowerDifference = 0.1;
const useDeploymentTest = false;

function onBotPlay(game, playerNumber) {
    if (useDeploymentTest) {
        return onBotPlayDeploymentTest(game, playerNumber);
    }

    return onBotPlayLine(game, playerNumber);
}

function onBotPlayDeploymentTest(game, playerNumber) {
    const submission = { orders: [], autofireConfigChanges: [], formationChanges: [] };

    if (game.turnNumber === 0) {
        game.getUnits()
            .filter(unit => unit.player === playerNumber)
            .forEach(unit => {
                submission.orders.push({
                    type: 5,
                    id: unit.id,
                    pos: [unit.position.x + 10, unit.position.y],
                    rotation: unit.rotation
                });
            });
    }

    return submission;
}

function onBotPlayLine(game, playerNumber) {
    const friendlyUnits = game.getUnits().filter(unit => unit.player === playerNumber);
    const visibleEnemies = game.getVisibleEnemyUnits(playerNumber);
    const stateKey = String(game.id) + ":" + playerNumber;
    let state = botStates.get(stateKey);

    if (!state) {
        state = createLineState(friendlyUnits);
        botStates.set(stateKey, state);
    }

    const submission = { orders: [], autofireConfigChanges: [], formationChanges: [] };
    const teamZones = game.map.deploymentZones.find(entry => entry.team === game.getPlayerTeam(playerNumber)).zones;
    const mainZone = teamZones.find(zone => zone.type === "main");
    const zoneBounds = getZoneBounds(mainZone, game.map);
    const faceEnemy = playerNumber === 1 ? 3 * Math.PI / 2 : Math.PI / 2;

    if (!state.deployed && game.turnNumber === 0) {
        submission.orders.push(...deployLine(state, friendlyUnits, playerNumber));
        submission.formationChanges.push(...getFormationChanges(state, friendlyUnits, visibleEnemies, true));
        state.staged = true;
        state.deployed = true;
        return submission;
    }

    if (!state.staged) {
        submission.orders.push(...stageLine(state, friendlyUnits, zoneBounds || { x: 0, y: game.map.height * 0.25, width: game.map.width, height: game.map.height * 0.5 }, playerNumber));
        submission.formationChanges.push(...getFormationChanges(state, friendlyUnits, visibleEnemies, true));
        state.staged = true;
        return submission;
    }

    const unitsById = new Map(friendlyUnits.map(unit => [unit.id, unit]));
    const powerLostDifference = getPowerLostDifference(game, playerNumber);
    const adjacentInfantryIds = getActiveArtilleryAdjacentInfantryIds(state, unitsById);
    updateLocalMopUpUnits(state, friendlyUnits, visibleEnemies, adjacentInfantryIds, powerLostDifference);
    const activeLine = promoteFollowers(state, unitsById);
    const artilleryOrders = new Map();
    const responsiveFollowers = [];
    const followerOrders = [];

    for (const slot of state.lineSlots) {
        if (slot.kind === "artillery") {
            const artillery = unitsById.get(slot.unitId);
            if (artillery && !artillery.isRoutingOrRecovering()) {
                const enemyWithinAdvanceRange = visibleEnemies.some(enemy => artillery.position.distanceTo(enemy.position) <= engagementRange);
                artilleryOrders.set(artillery.id, enemyWithinAdvanceRange ? 4 : 2);
                activeLine.push({ unit: artillery, slot, x: artillery.position.x, kind: "artillery" });
            }

            const artilleryUnavailable = !artillery || artillery.hp <= 0 || artillery.isRoutingOrRecovering();
            const followers = state.followersByArtillery.get(slot.artilleryId) || [];
            followers.forEach(followerId => {
                const follower = unitsById.get(followerId);
                if (follower && !follower.isRoutingOrRecovering()) {
                    if (artilleryUnavailable) {
                        responsiveFollowers.push({ unit: follower, x: follower.position.x, kind: "infantry" });
                    } else {
                        const followerIsAhead = (playerNumber === 1 ? -1 : 1) * follower.position.y > (playerNumber === 1 ? -1 : 1) * artillery.position.y;
                        followerOrders.push({ type: followerIsAhead ? 6 : 1, id: follower.id, targetId: artillery.id });
                    }
                }
            });
        } else {
            const unit = unitsById.get(slot.unitId);
            if (unit && !unit.isRoutingOrRecovering()) {
                activeLine.push({ unit, slot, x: unit.position.x, kind: "infantry" });
                const followers = state.followersByArtillery.get(slot.artilleryId) || [];
                followers.forEach(followerId => {
                    const follower = unitsById.get(followerId);
                    if (follower && !follower.isRoutingOrRecovering()) {
                        followerOrders.push({ type: 1, id: follower.id, targetId: unit.id });
                    }
                });
            }
        }
    }

    state.reserveIds.forEach(unitId => {
        const unit = unitsById.get(unitId);
        if (unit && infantryCategories.includes(unit.category) && !unit.isRoutingOrRecovering()) {
            activeLine.push({ unit, slot: null, x: unit.position.x, kind: "infantry" });
        }
    });

    activeLine.push(...responsiveFollowers);
    const activeWithOrders = activeLine.map(record => {
        const order = artilleryOrders.get(record.unit.id) || 1;
        const reachOrder = order === 2 ? 2 : 1;
        const reach = game.getMovementReach(record.unit, { order: reachOrder, direction: faceEnemy });
        return { ...record, order, reach, progress: (playerNumber === 1 ? -1 : 1) * record.unit.position.y };
    });
    const followerIds = new Set();
    state.followersByArtillery.forEach(ids => ids.forEach(id => followerIds.add(id)));
    const movementLimitUnits = activeWithOrders.filter(record => !followerIds.has(record.unit.id));
    const mapEdgeProgress = (playerNumber === 1 ? -1 : 1) * (playerNumber === 1 ? 5 : game.map.height - 5);
    const slowestReachProgress = Math.min(...movementLimitUnits.map(record => (playerNumber === 1 ? -1 : 1) * record.reach.position.y));
    const targetProgress = Math.min(slowestReachProgress + 10, mapEdgeProgress);
    const targetY = (playerNumber === 1 ? -1 : 1) * targetProgress;

    state.mopUp = state.mopUp || powerLostDifference > mopUpPowerDifference;

    if (state.mopUp || state.mopUpUnitIds.size) {
        const selectedMopUpIds = getMopUpUnitSelection(state, friendlyUnits);
        submission.orders.push(...getMopUpOrders(game, friendlyUnits, visibleEnemies, playerNumber, selectedMopUpIds));
        submission.orders.push(...getCavalryOrders(game, state, unitsById, visibleEnemies, playerNumber, faceEnemy, targetProgress, targetY, true, selectedMopUpIds));
        if (state.mopUp) {
            submission.formationChanges.push(...getFormationChanges(state, friendlyUnits, visibleEnemies, false));
            return submission;
        }
    }

    const selectedMopUpIds = state.mopUp || state.mopUpUnitIds.size ? getMopUpUnitSelection(state, friendlyUnits) : new Set();
    submission.orders.push(...followerOrders.filter(order => !selectedMopUpIds.has(order.id)));
    activeWithOrders.filter(record => !selectedMopUpIds.has(record.unit.id)).forEach(record => {
        const orderType = record.kind === "artillery" ? record.order : 4;
        const destinationY = record.progress >= targetProgress ? record.unit.position.y : targetY;
        submission.orders.push({
            type: orderType,
            id: record.unit.id,
            path: [[record.x, destinationY]],
            rotation: faceEnemy
        });
    });
    const movementByUnitId = new Map(activeWithOrders.filter(record => !selectedMopUpIds.has(record.unit.id)).map(record => [record.unit.id, record]));
    state.skirmishByTarget.forEach((skirmisherIds, targetId) => {
        if (selectedMopUpIds.has(targetId)) {
            return;
        }
        const targetRecord = movementByUnitId.get(targetId);
        if (targetRecord) {
            const skirmishTarget = getForwardPosition(targetRecord.reach.position, 25, playerNumber);
            skirmisherIds.forEach(skirmisherId => {
                const skirmisher = unitsById.get(skirmisherId);
                if (skirmisher && !selectedMopUpIds.has(skirmisher.id) && !skirmisher.isRoutingOrRecovering()) {
                    const targetIsFireAdvance = targetRecord.kind === "artillery" ? targetRecord.order === 4 : targetRecord.unit.effectiveFormation === "line";
                    const directionSign = playerNumber === 1 ? -1 : 1;
                    const skirmisherProgress = directionSign * skirmisher.position.y;
                    const targetProgress = directionSign * targetRecord.unit.position.y;
                    if (targetIsFireAdvance && skirmisherProgress - targetProgress > 25) {
                        const retreatTarget = getForwardPosition(targetRecord.unit.position, 35, playerNumber);
                        submission.orders.push({
                            type: 6,
                            id: skirmisher.id,
                            path: [[retreatTarget.x, retreatTarget.y]],
                            rotation: faceEnemy
                        });
                        return;
                    }
                    submission.orders.push({
                        type: 4,
                        id: skirmisher.id,
                        path: [[skirmishTarget.x, skirmishTarget.y]],
                        rotation: faceEnemy
                    });
                }
            });
        }
    });
    submission.orders.push(...getCavalryOrders(game, state, unitsById, visibleEnemies, playerNumber, faceEnemy, targetProgress, targetY, false, selectedMopUpIds));
    submission.formationChanges.push(...getFormationChanges(state, friendlyUnits, visibleEnemies, false));
    return submission;
}

function getPowerLostDifference(game, playerNumber) {
    const botTeam = game.getPlayerTeam(playerNumber);
    const teamStats = game.vpService.getTeamsVictoryStats();
    const botStats = teamStats.find(record => record.team === botTeam);
    const enemyStats = teamStats.find(record => record.team !== botTeam);
    const botPowerLost = 1 - botStats.currentArmyPower / botStats.initialArmyPower;
    const enemyPowerLost = 1 - enemyStats.currentArmyPower / enemyStats.initialArmyPower;
    return enemyPowerLost - botPowerLost;
}

function getActiveArtilleryAdjacentInfantryIds(state, unitsById) {
    const adjacentInfantryIds = new Set();
    state.lineSlots.forEach((slot, index) => {
        if (slot.kind !== "artillery") {
            return;
        }
        const artillery = unitsById.get(slot.unitId);
        if (!artillery || artillery.hp <= 0 || artillery.isRoutingOrRecovering()) {
            return;
        }
        [index - 1, index + 1].forEach(adjacentIndex => {
            const adjacentSlot = state.lineSlots[adjacentIndex];
            const adjacentUnit = adjacentSlot && unitsById.get(adjacentSlot.unitId);
            if (adjacentSlot && adjacentSlot.kind === "infantry" && adjacentUnit && !adjacentUnit.isRoutingOrRecovering()) {
                adjacentInfantryIds.add(adjacentUnit.id);
            }
        });
    });
    return adjacentInfantryIds;
}

function updateLocalMopUpUnits(state, friendlyUnits, visibleEnemies, adjacentInfantryIds, powerLostDifference) {
    const activeArmy = friendlyUnits.filter(unit => !unit.isRoutingOrRecovering());
    const unitsWithNearbyEnemy = activeArmy.filter(unit => visibleEnemies.some(enemy => !enemy.isRouting() && unit.position.distanceTo(enemy.position) <= 150));
    if (unitsWithNearbyEnemy.length < activeArmy.length / 3) {
        state.noEnemyTurns.clear();
        return;
    }

    activeArmy.forEach(unit => {
        const hasNearbyEnemy = unitsWithNearbyEnemy.includes(unit);
        if (hasNearbyEnemy) {
            state.noEnemyTurns.set(unit.id, 0);
        } else {
            const turnsWithoutEnemy = (state.noEnemyTurns.get(unit.id) || 0) + 1;
            state.noEnemyTurns.set(unit.id, turnsWithoutEnemy);
            const requiredPowerDifference = adjacentInfantryIds.has(unit.id) ? mopUpAdjacentInfantryPowerDifference : 0;
            if (turnsWithoutEnemy >= 2 && powerLostDifference >= requiredPowerDifference) {
                state.mopUpUnitIds.add(unit.id);
            }
        }
    });
}

function getMopUpUnitSelection(state, friendlyUnits) {
    if (!state.mopUp) {
        return state.mopUpUnitIds;
    }

    return new Set(friendlyUnits.map(unit => unit.id));
}

function getMopUpOrders(game, friendlyUnits, visibleEnemies, playerNumber, selectedUnitIds = null) {
    const botTeam = game.getPlayerTeam(playerNumber);
    const enemyObjectives = game.getObjectives().filter(objective => objective.team !== undefined && objective.team !== botTeam);
    const mopUpRecords = friendlyUnits
        .filter(unit => (!selectedUnitIds || selectedUnitIds.has(unit.id)) && (unit.category === "artillery" || unit.category === "skirmishInfantry" || infantryCategories.includes(unit.category)) && !unit.isRoutingOrRecovering())
        .map(unit => {
            const kind = unit.category === "artillery" ? "artillery" : unit.category === "skirmishInfantry" ? "skirmish" : "infantry";
            const enemyTargets = visibleEnemies
                .filter(enemy => isValidMopUpEnemyTarget(game, unit, enemy, visibleEnemies))
                .map(enemy => ({ target: enemy, distance: unit.position.distanceTo(enemy.position) }));
            const objectiveTargets = kind === "infantry"
                ? enemyObjectives.map(objective => ({ target: objective, distance: unit.position.distanceTo(objective.position) }))
                : [];
            return {
                unit,
                kind,
                candidates: [...enemyTargets, ...objectiveTargets].sort((left, right) => left.distance - right.distance)
            };
        });
    const claims = { infantry: new Set(), artillery: new Set(), skirmish: new Set() };
    const assignments = new Map();
    const unassignedUnitIds = new Set(mopUpRecords.map(record => record.unit.id));

    while (unassignedUnitIds.size) {
        let closestPair;
        mopUpRecords.forEach(record => {
            if (!unassignedUnitIds.has(record.unit.id)) {
                return;
            }
            const nextTarget = record.candidates.find(entry => !isMopUpTargetClaimed(record.kind, entry.target.id, claims));
            if (nextTarget && (!closestPair || nextTarget.distance < closestPair.entry.distance)) {
                closestPair = { record, entry: nextTarget };
            }
        });
        if (!closestPair) {
            break;
        }
        assignments.set(closestPair.record.unit.id, closestPair.entry);
        claims[closestPair.record.kind].add(closestPair.entry.target.id);
        unassignedUnitIds.delete(closestPair.record.unit.id);
    }

    return mopUpRecords.flatMap(record => {
        const assignment = assignments.get(record.unit.id);
        if (!assignment) {
            return [];
        }
        const direction = assignment.target.position.subtract(record.unit.position).angle();
        const artilleryIsClose = record.kind === "artillery" && visibleEnemies.some(enemy => !enemy.isRouting() && record.unit.position.distanceTo(enemy.position) <= engagementRange);
        return [{
            type: artilleryIsClose ? 4 : record.kind === "artillery" ? 2 : 4,
            id: record.unit.id,
            path: [[assignment.target.position.x, assignment.target.position.y]],
            rotation: direction
        }];
    });
}

function isValidMopUpEnemyTarget(game, unit, enemy, visibleEnemies) {
    return !enemy.isRouting();
}

function isMopUpTargetClaimed(kind, targetId, claims) {
    if (kind === "infantry") {
        return claims.infantry.has(targetId) || claims.artillery.has(targetId);
    }
    if (kind === "artillery") {
        return claims.infantry.has(targetId) || claims.artillery.has(targetId);
    }
    return claims.skirmish.has(targetId);
}

function getCavalryOrders(game, state, unitsById, visibleEnemies, playerNumber, faceEnemy, targetProgress, targetY, mopUp = false, mopUpUnitIds = null) {
    const cavalryRecords = state.cavalryIds
        .filter(cavalryId => !mopUpUnitIds || (mopUp ? mopUpUnitIds.has(cavalryId) : !mopUpUnitIds.has(cavalryId)))
        .map(cavalryId => unitsById.get(cavalryId))
        .filter(cavalry => cavalry && !cavalry.isRoutingOrRecovering())
        .map(cavalry => {
            const targetEntries = visibleEnemies
                .filter(enemy => !enemy.isRouting())
                .map(enemy => {
                    const toEnemy = enemy.position.subtract(cavalry.position);
                    const reach = game.getMovementReach(cavalry, { order: 2, direction: toEnemy.angle() });
                    return { enemy, distance: toEnemy.length(), reach, inRunRange: !reach.blocked && toEnemy.length() <= reach.distance };
                })
                .sort((left, right) => left.distance - right.distance);
            const reachableEnemies = targetEntries.filter(entry => entry.inRunRange);
            return {
                cavalry,
                targetEntries,
                reachableEnemies,
                validTargets: mopUp
                    ? targetEntries.filter(entry => !entry.inRunRange || isValidCavalryTarget(game, cavalry, entry.enemy, visibleEnemies))
                    : reachableEnemies.filter(entry => isValidCavalryTarget(game, cavalry, entry.enemy, visibleEnemies))
            };
        });
    const assignments = new Map();
    const selectedTargetIds = new Set();
    const unassignedCavalryIds = new Set(cavalryRecords.map(record => record.cavalry.id));

    while (unassignedCavalryIds.size) {
        let closestPair;
        cavalryRecords.forEach(record => {
            if (!unassignedCavalryIds.has(record.cavalry.id)) {
                return;
            }
            const closestEnemy = record.reachableEnemies[0];
            if (closestEnemy && isCavalryFallbackTarget(closestEnemy.enemy) && !isValidCavalryTarget(game, record.cavalry, closestEnemy.enemy, visibleEnemies)) {
                return;
            }
            const nextTarget = record.validTargets.find(entry => !selectedTargetIds.has(entry.enemy.id));
            if (nextTarget && (!closestPair || nextTarget.distance < closestPair.entry.distance)) {
                closestPair = { record, entry: nextTarget };
            }
        });
        if (!closestPair) {
            break;
        }
        assignments.set(closestPair.record.cavalry.id, closestPair.entry.enemy.id);
        selectedTargetIds.add(closestPair.entry.enemy.id);
        unassignedCavalryIds.delete(closestPair.record.cavalry.id);
    }

    return cavalryRecords.map(record => {
        const closestEnemy = record.reachableEnemies[0];
        if (closestEnemy && isCavalryFallbackTarget(closestEnemy.enemy) && !isValidCavalryTarget(game, record.cavalry, closestEnemy.enemy, visibleEnemies)) {
            const awayDirection = record.cavalry.position.subtract(closestEnemy.enemy.position).angle();
            const fallbackReach = game.getMovementReach(record.cavalry, { order: 6, direction: awayDirection });
            return {
                type: 6,
                id: record.cavalry.id,
                path: [[fallbackReach.position.x, fallbackReach.position.y]],
                rotation: awayDirection
            };
        }
        if (mopUp) {
            const targetId = assignments.get(record.cavalry.id);
            const targetEntry = record.targetEntries.find(entry => entry.enemy.id === targetId);
            if (targetEntry) {
                if (targetEntry.inRunRange) {
                    return { type: 2, id: record.cavalry.id, targetId: targetEntry.enemy.id };
                }
                const direction = targetEntry.enemy.position.subtract(record.cavalry.position).angle();
                return {
                    type: 1,
                    id: record.cavalry.id,
                    path: [[targetEntry.enemy.position.x, targetEntry.enemy.position.y]],
                    rotation: direction
                };
            }
        }
        const targetId = assignments.get(record.cavalry.id);
        if (targetId !== undefined) {
            return { type: 2, id: record.cavalry.id, targetId };
        }

        const progress = (playerNumber === 1 ? -1 : 1) * record.cavalry.position.y;
        const destinationY = progress >= targetProgress ? record.cavalry.position.y : targetY;
        return { type: 1, id: record.cavalry.id, path: [[record.cavalry.position.x, destinationY]], rotation: faceEnemy };
    });
}

function isValidCavalryTarget(game, cavalry, enemy, visibleEnemies) {
    if (enemy.category === "skirmishInfantry" || cavalryCategories.includes(enemy.category)) {
        if (cavalryCategories.includes(enemy.category)) {
            return true;
        }
        return !isSkirmisherInCover(game, enemy) && !isSkirmisherScreened(cavalry, enemy, visibleEnemies);
    }

    if (enemy.category === "artillery" || infantryCategories.includes(enemy.category)) {
        return enemy.effectiveFormation !== "square" && (enemy.isRunning(2) || enemy.getOrgProportion() < 0.6 || isFacingAwayFromCavalry(cavalry, enemy));
    }

    return false;
}

function isCavalryFallbackTarget(enemy) {
    return enemy.category === "artillery" || infantryCategories.includes(enemy.category) || enemy.category === "skirmishInfantry";
}

function isSkirmisherInCover(game, enemy) {
    const formation = enemy.gameDataManager.getFormationManager().getTemplate(enemy.currentFormation);
    const checkPoints = formation && formation.checkPoints ? formation.checkPoints : [{ x: 0, y: 0, weight: 1 }];
    const tileSize = enemy.gameDataManager.getGameConstants().TILE_SIZE;
    let coveredWeight = 0;
    let totalWeight = 0;
    checkPoints.forEach(checkPoint => {
        const cosTheta = Math.cos(-enemy.rotation);
        const sinTheta = Math.sin(-enemy.rotation);
        const point = {
            x: enemy.position.x + checkPoint.x * cosTheta + checkPoint.y * sinTheta,
            y: enemy.position.y + -checkPoint.x * sinTheta + checkPoint.y * cosTheta
        };
        if (!game.isPointOutsideMap(point)) {
            const terrain = game.map.terrains[Math.floor(point.x / tileSize)][Math.floor(point.y / tileSize)];
            totalWeight += checkPoint.weight;
            if (terrain === 1 || terrain === 2 || terrain === 13) {
                coveredWeight += checkPoint.weight;
            }
        }
    });
    return coveredWeight > totalWeight * 0.5;
}

function isSkirmisherScreened(cavalry, skirmisher, visibleEnemies) {
    return visibleEnemies.some(enemy => {
        const isScreeningUnit = enemy.category === "artillery" || infantryCategories.includes(enemy.category);
        return !enemy.isRouting() && isScreeningUnit && skirmisher.position.distanceTo(enemy.position) <= 100 && !isValidCavalryTargetForScreen(cavalry, enemy);
    });
}

function isValidCavalryTargetForScreen(cavalry, enemy) {
    return enemy.effectiveFormation !== "square" && (enemy.isRunning(2) || enemy.getOrgProportion() < 0.6 || isFacingAwayFromCavalry(cavalry, enemy));
}

function isFacingAwayFromCavalry(cavalry, enemy) {
    const directionToCavalry = cavalry.position.subtract(enemy.position).angle();
    const angleDifference = Math.abs(Math.atan2(Math.sin(enemy.rotation - directionToCavalry), Math.cos(enemy.rotation - directionToCavalry)));
    const requiredDifference = enemy.category === "artillery" ? 45 * Math.PI / 180 : 100 * Math.PI / 180;
    return angleDifference >= requiredDifference;
}

function createLineState(friendlyUnits) {
    const artillery = friendlyUnits.filter(unit => unit.category === "artillery");
    const infantry = friendlyUnits.filter(unit => infantryCategories.includes(unit.category));
    const lineInfantryCount = artillery.length ? Math.min(artillery.length, Math.max(0, infantry.length - artillery.length)) : infantry.length;
    const lineInfantry = infantry.slice(0, lineInfantryCount);
    const reserveInfantry = infantry.slice(lineInfantryCount, lineInfantryCount + artillery.length);
    const state = { lineSlots: [], followersByArtillery: new Map(), skirmishByTarget: new Map(), cavalryIds: friendlyUnits.filter(unit => cavalryCategories.includes(unit.category)).map(unit => unit.id), deployed: false, staged: false, mopUp: false, mopUpUnitIds: new Set(), noEnemyTurns: new Map(), reserveIds: new Set(), reserveLinePositions: new Map(), cavalryLinePositions: new Map() };
    const pairCount = Math.max(artillery.length, lineInfantry.length);

    for (let index = 0; index < pairCount; index += 1) {
        if (artillery[index]) {
            state.lineSlots.push({ unitId: artillery[index].id, artilleryId: artillery[index].id, kind: "artillery" });
        }
        if (lineInfantry[index]) {
            state.lineSlots.push({ unitId: lineInfantry[index].id, kind: "infantry" });
        }
    }
    state.lineSlots.forEach((slot, index) => {
        slot.xRatio = (index + 0.5) / Math.max(1, state.lineSlots.length);
    });

    artillery.forEach(unit => state.followersByArtillery.set(unit.id, []));
    reserveInfantry.forEach((unit, index) => {
        if (artillery.length) {
            state.followersByArtillery.get(artillery[index % artillery.length].id).push(unit.id);
            state.reserveIds.add(unit.id);
        }
    });

    const lineTargets = state.lineSlots
        .map((slot, index) => ({ slot, index }))
        .filter(record => record.slot.kind === "infantry")
        .sort((left, right) => Math.abs(left.index - (state.lineSlots.length - 1) / 2) - Math.abs(right.index - (state.lineSlots.length - 1) / 2))
        .map(record => record.slot.unitId);
    const flankTargets = friendlyUnits
        .filter(unit => infantryCategories.includes(unit.category) && !state.lineSlots.some(slot => slot.unitId === unit.id) && !state.reserveIds.has(unit.id))
        .map(unit => unit.id);
    const skirmishers = friendlyUnits.filter(unit => unit.category === "skirmishInfantry");
    const skirmishTargets = [...artillery.map(unit => unit.id), ...lineTargets, ...flankTargets];
    skirmishers.forEach((unit, index) => {
        const targetId = skirmishTargets[index];
        if (targetId !== undefined) {
            state.skirmishByTarget.set(targetId, [unit.id]);
        }
    });

    const assignedIds = new Set([...state.lineSlots.map(slot => slot.unitId), ...state.reserveIds]);
    state.reserveIds = new Set(friendlyUnits.filter(unit => !assignedIds.has(unit.id)).map(unit => unit.id));
    return state;
}

function deployLine(state, friendlyUnits, playerNumber) {
    const orders = [];
    const sign = playerNumber === 1 ? 1 : -1;
    const lineUnits = friendlyUnits.filter(unit => state.lineSlots.some(slot => slot.unitId === unit.id));
    const xValues = lineUnits.map(unit => unit.position.x);
    const lineLeft = Math.min(...xValues);
    const lineRight = Math.max(...xValues);
    const lineY = lineUnits.reduce((total, unit) => total + unit.position.y, 0) / lineUnits.length;
    const lineSpacing = (lineRight - lineLeft) / Math.max(1, state.lineSlots.length - 1);
    const slotX = index => state.lineSlots.length === 1 ? (lineLeft + lineRight) / 2 : lineLeft + lineSpacing * index;
    const deployedIds = new Set();
    const lineDeploymentPositions = new Map();

    state.lineSlots.forEach((slot, index) => {
        const unit = friendlyUnits.find(candidate => candidate.id === slot.unitId);
        const x = slotX(index);
        orders.push({ type: 5, id: unit.id, pos: [x, lineY], rotation: playerNumber === 1 ? 3 * Math.PI / 2 : Math.PI / 2 });
        deployedIds.add(unit.id);
        lineDeploymentPositions.set(unit.id, { x, y: lineY });
        slot.xRatio = (index + 0.5) / Math.max(1, state.lineSlots.length);
    });

    state.followersByArtillery.forEach((followerIds, artilleryId) => {
        const artillerySlotIndex = state.lineSlots.findIndex(slot => slot.artilleryId === artilleryId);
        followerIds.forEach((followerId, followerIndex) => {
            const follower = friendlyUnits.find(unit => unit.id === followerId);
            const yOffset = sign * (20 + followerIndex * 5);
            orders.push({ type: 5, id: follower.id, pos: [slotX(artillerySlotIndex), lineY + yOffset], rotation: playerNumber === 1 ? 3 * Math.PI / 2 : Math.PI / 2 });
            deployedIds.add(follower.id);
        });
    });

    const extensionSpacing = Math.max(10, lineSpacing);
    Array.from(state.reserveIds).filter(unitId => {
        const unit = friendlyUnits.find(candidate => candidate.id === unitId);
        return unit && infantryCategories.includes(unit.category);
    }).forEach((unitId, reserveIndex) => {
        const side = reserveIndex % 2 === 0 ? -1 : 1;
        const distance = (Math.floor(reserveIndex / 2) + 1) * extensionSpacing;
        const x = side < 0 ? lineLeft - distance : lineRight + distance;
        const unit = friendlyUnits.find(candidate => candidate.id === unitId);
        if (unit && infantryCategories.includes(unit.category)) {
            orders.push({ type: 5, id: unit.id, pos: [x, lineY], rotation: playerNumber === 1 ? 3 * Math.PI / 2 : Math.PI / 2 });
            deployedIds.add(unit.id);
            lineDeploymentPositions.set(unit.id, { x, y: lineY });
            state.reserveLinePositions.set(unitId, x);
        }
    });

    const lineCenter = (lineLeft + lineRight) / 2;
    const leftReserveCount = [...state.reserveLinePositions.values()].filter(x => x < lineCenter).length;
    const rightReserveCount = [...state.reserveLinePositions.values()].filter(x => x >= lineCenter).length;
    let leftCavalryIndex = 0;
    let rightCavalryIndex = 0;
    state.cavalryIds.forEach((cavalryId, cavalryIndex) => {
        const cavalry = friendlyUnits.find(unit => unit.id === cavalryId);
        const onLeft = cavalryIndex % 2 === 0;
        const sideIndex = onLeft ? leftCavalryIndex++ : rightCavalryIndex++;
        const distance = (sideIndex + (onLeft ? leftReserveCount : rightReserveCount) + 1) * extensionSpacing;
        const x = onLeft ? lineLeft - distance : lineRight + distance;
        orders.push({ type: 5, id: cavalry.id, pos: [x, lineY], rotation: playerNumber === 1 ? 3 * Math.PI / 2 : Math.PI / 2 });
        deployedIds.add(cavalry.id);
        state.cavalryLinePositions.set(cavalryId, { x, y: lineY });
    });

    state.skirmishByTarget.forEach((skirmisherIds, targetId) => {
        const targetPosition = lineDeploymentPositions.get(targetId) || friendlyUnits.find(unit => unit.id === targetId).position;
        const skirmishPosition = getForwardPosition(targetPosition, 25, playerNumber);
        skirmisherIds.forEach(skirmisherId => {
            const skirmisher = friendlyUnits.find(unit => unit.id === skirmisherId);
            orders.push({ type: 5, id: skirmisher.id, pos: [skirmishPosition.x, skirmishPosition.y], rotation: playerNumber === 1 ? 3 * Math.PI / 2 : Math.PI / 2 });
            deployedIds.add(skirmisher.id);
        });
    });

    const otherUnits = friendlyUnits.filter(unit => !deployedIds.has(unit.id));
    otherUnits.forEach((unit, index) => {
        orders.push({ type: 5, id: unit.id, pos: [unit.position.x, unit.position.y], rotation: playerNumber === 1 ? 3 * Math.PI / 2 : Math.PI / 2 });
    });

    return orders;
}

function stageLine(state, friendlyUnits, zone, playerNumber) {
    const orders = [];
    const faceEnemy = playerNumber === 1 ? 3 * Math.PI / 2 : Math.PI / 2;
    const frontY = zone.y + zone.height * (playerNumber === 1 ? 0.35 : 0.65);
    state.lineSlots.forEach((slot, index) => {
        const unit = friendlyUnits.find(candidate => candidate.id === slot.unitId);
        if (unit && !unit.isRoutingOrRecovering()) {
            orders.push({
                type: slot.kind === "artillery" ? 2 : 1,
                id: unit.id,
                path: [[unit.position.x, frontY]],
                rotation: faceEnemy
            });
        }
    });

    state.cavalryIds.forEach(cavalryId => {
        const cavalry = friendlyUnits.find(unit => unit.id === cavalryId);
        if (cavalry && !cavalry.isRoutingOrRecovering()) {
            orders.push({ type: 1, id: cavalry.id, path: [[cavalry.position.x, frontY]], rotation: faceEnemy });
        }
    });

    state.followersByArtillery.forEach((followerIds, artilleryId) => {
        followerIds.forEach(followerId => {
            const follower = friendlyUnits.find(unit => unit.id === followerId);
            const artillery = friendlyUnits.find(unit => unit.id === artilleryId);
            if (follower && artillery && !follower.isRoutingOrRecovering()) {
                const followerIsAhead = (playerNumber === 1 ? -1 : 1) * follower.position.y > (playerNumber === 1 ? -1 : 1) * artillery.position.y;
                orders.push({ type: followerIsAhead ? 6 : 1, id: follower.id, targetId: artillery.id });
            }
        });
    });

    return orders;
}

function promoteFollowers(state, unitsById) {
    const activeLine = [];
    state.lineSlots.forEach(slot => {
        if (slot.kind === "artillery") {
            const artillery = unitsById.get(slot.unitId);
            if (!artillery || artillery.hp <= 0) {
                const followers = state.followersByArtillery.get(slot.artilleryId) || [];
                const replacementId = followers.find(id => unitsById.has(id) && unitsById.get(id).hp > 0 && !unitsById.get(id).isRoutingOrRecovering());
                if (replacementId) {
                    slot.unitId = replacementId;
                    slot.kind = "infantry";
                    state.followersByArtillery.set(slot.artilleryId, followers.filter(id => id !== replacementId));
                }
            }
        }
    });
    return activeLine;
}

function getLinePositions(state, zone) {
    const spacing = zone.width / Math.max(1, state.lineSlots.length);
    const positions = new Map();
    state.lineSlots.forEach(slot => positions.set(slot, zone.x + zone.width * slot.xRatio));
    positions.spacing = spacing;
    return positions;
}

function getForwardPosition(position, distance, playerNumber) {
    return { x: position.x, y: position.y + (playerNumber === 1 ? -1 : 1) * distance };
}

function getZonePoints(zone) {
    const rawPoints = zone && (zone.edges || zone.vertices || zone.points || zone.polygon && (zone.polygon.edges || zone.polygon.vertices || zone.polygon.points) || zone.shape && (zone.shape.edges || zone.shape.vertices || zone.shape.points));
    if (!Array.isArray(rawPoints)) {
        return [];
    }

    return rawPoints.flatMap(point => {
        if (Array.isArray(point)) {
            return [{ x: point[0], y: point[1] }];
        }
        if (point && point.start && point.end) {
            const start = Array.isArray(point.start) ? { x: point.start[0], y: point.start[1] } : point.start;
            const end = Array.isArray(point.end) ? { x: point.end[0], y: point.end[1] } : point.end;
            return [start, end];
        }
        if (point && point.x !== undefined && point.y !== undefined) {
            return [point];
        }
        return [];
    });
}

function getZoneBounds(zone, map) {
    const points = getZonePoints(zone);
    if (points.length >= 3) {
        const xs = points.map(point => point.x);
        const ys = points.map(point => point.y);
        return {
            x: Math.min(...xs),
            y: Math.min(...ys),
            width: Math.max(...xs) - Math.min(...xs),
            height: Math.max(...ys) - Math.min(...ys)
        };
    }

    if (zone && zone.width !== undefined && zone.height !== undefined) {
        return { x: zone.x, y: zone.y, width: zone.width, height: zone.height };
    }

    return map ? { x: 0, y: 0, width: map.width, height: map.height } : null;
}

function getFormationChanges(state, friendlyUnits, visibleEnemies, deploying) {
    const changes = [];
    const unitsById = new Map(friendlyUnits.map(unit => [unit.id, unit]));
    const lineIds = new Set(state.lineSlots.map(slot => slot.unitId));

    state.lineSlots.forEach(slot => {
        const unit = unitsById.get(slot.unitId);
        if (unit && infantryCategories.includes(unit.category)) {
            const promotedIntoArtillerySlot = slot.kind === "infantry" && slot.artilleryId !== undefined;
            const threatNearby = visibleEnemies.some(enemy => unit.position.distanceTo(enemy.position) <= engagementRange);
            const formationId = promotedIntoArtillerySlot || threatNearby ? "line" : "column";
            if (unit.effectiveFormation !== formationId) {
                changes.push({ unitId: unit.id, formationId });
            }
        }
    });

    state.followersByArtillery.forEach((followerIds, artilleryId) => {
        const artillery = unitsById.get(artilleryId);
        const artilleryUnavailable = !artillery || artillery.hp <= 0 || artillery.isRoutingOrRecovering();
        followerIds.forEach((followerId, followerIndex) => {
            const follower = unitsById.get(followerId);
            if (follower && !lineIds.has(follower.id)) {
                const threatNearby = visibleEnemies.some(enemy => follower.position.distanceTo(enemy.position) <= engagementRange);
                const formationId = threatNearby || artilleryUnavailable ? "line" : "column";
                if (follower.effectiveFormation !== formationId) {
                    changes.push({ unitId: follower.id, formationId });
                }
            }
        });
    });

    state.reserveIds.forEach(unitId => {
        const unit = unitsById.get(unitId);
        if (unit && infantryCategories.includes(unit.category)) {
            const threatNearby = visibleEnemies.some(enemy => unit.position.distanceTo(enemy.position) <= engagementRange);
            const formationId = threatNearby ? "line" : "column";
            if (unit.effectiveFormation !== formationId) {
                changes.push({ unitId: unit.id, formationId });
            }
        }
    });

    return changes;
}
