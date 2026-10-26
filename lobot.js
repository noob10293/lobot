const commandstate = new Map();
const frontlineReplacementDistance = 100;
const infantryCatchupDistance = 50;
const reserveLineChangeDistance = 100;
const centerObjectiveRowTolerance = 50;
const centerObjectiveMaxDistanceRatio = 0.15;
const orgtoreplace=0.7

function onBotPlay(game, playerNumber) {
    // INITS
    const allUnits = game.getUnits();
    const turnSubmission = { orders: [], autofireConfigChanges: [], formationChanges: [] };



    // LOGS
    // console.log("Unit categories:", allUnits.map(unit => ({
    //   id: unit.id,
    //   player: unit.player,
    //   category: unit.category
    // })));
    console.log(game)
    const visibleEnemyUnits = game.getVisibleEnemyUnits(playerNumber);
    console.log("Visible enemy units:", visibleEnemyUnits.map(unit => ({ id: unit.id, category: unit.category, x: unit.position.x, y: unit.position.y })));



    // UNITS
    const myUnits = allUnits.filter(unit => unit.player === playerNumber);
    const enemyUnits = allUnits.filter(unit => unit.team !== game.getPlayerTeam(playerNumber));
    // Group units by their battlefield category.
    const mycav = myUnits.filter(unit => ["scoutCavalry", "lightCavalry", "midCavalry", "heavyCavalry"].includes(unit.category));
    const myarty = myUnits.filter(unit => unit.category === "artillery");
    const myinf = myUnits.filter(unit => ["infantry", "guardsInfantry", "militiaInfantry"].includes(unit.category));
    const myskirms = myUnits.filter(unit => unit.category === "skirmishInfantry");



    const playerValues = initplayervalues(game, playerNumber);
    turnSubmission.orders.push(...infcommander(game, myinf, playerValues));
    turnSubmission.orders.push(...skirmcommander(game, myskirms, myinf, playerValues));
    turnSubmission.formationChanges.push(...infantryFormationChanges(
        myinf,
        visibleEnemyUnits,
        commandstate.get("reserveIds"),
        commandstate.get("reserveAssignments")
    ));



    return turnSubmission;
}

function skirmcommander(game, skirmishers, infantry, playerValues) {
    const readySkirmishers = skirmishers.filter(unit => !unit.isRoutingOrRecovering());
    const tileSize = game.map.width / game.map.terrains.length;
    const mapCenter = { x: game.map.width / 2, y: game.map.height / 2 };
    const frontlineIds = commandstate.get("frontlineIds") || [];
    const frontlineInfantry = infantry.filter(unit => frontlineIds.includes(unit.id));
    const averageLineY = frontlineInfantry.reduce((total, unit) => total + unit.position.y, 0) / frontlineInfantry.length;
    const enemyIsAbove = playerValues.get("mapfarthesty") < mapCenter.y;
    const coverTerrainIds = new Set([1, 2, 12, 13]);
    const coverPositions = [];

    game.map.terrains.forEach((column, tileX) => {
        column.forEach((terrainId, tileY) => {
            const position = { x: (tileX + 0.5) * tileSize, y: (tileY + 0.5) * tileSize };
            const terrainOnFriendlySide = enemyIsAbove ? position.y >= mapCenter.y : position.y <= mapCenter.y;
            const terrainAheadOfLine = enemyIsAbove ? position.y <= averageLineY : position.y >= averageLineY;
            if (coverTerrainIds.has(terrainId) && terrainOnFriendlySide && terrainAheadOfLine) {
                coverPositions.push({
                    position,
                    centerDistance: Math.hypot(position.x - mapCenter.x, position.y - mapCenter.y)
                });
            }
        });
    });

    coverPositions.sort((a, b) => a.centerDistance - b.centerDistance);

    return readySkirmishers.slice(0, coverPositions.length).map((unit, index) => ({
        type: 2,
        id: unit.id,
        path: [[coverPositions[index].position.x, coverPositions[index].position.y]]
    }));
}

function infantryFormationChanges(infantry, visibleEnemyUnits, reserveIds = new Set(), reserveAssignments = new Map()) {
    const formationChanges = [];
    const readyInfantry = infantry.filter(unit => !unit.isRoutingOrRecovering());
    const unitsById = new Map(readyInfantry.map(unit => [unit.id, unit]));

    for (const unit of readyInfantry) {
        const multi=3;
        const enemyWithinRange = visibleEnemyUnits.some(enemy => {
            const distanceToEnemy = unit.position.distanceTo(enemy.position);
            return distanceToEnemy <= unit.getMaxRange() * multi;
        });
        const assignedFrontlineId = reserveAssignments.get(unit.id);
        const assignedFrontlineUnit = unitsById.get(assignedFrontlineId);
        const assignedFrontlineNearEnemy = assignedFrontlineUnit && visibleEnemyUnits.some(enemy => assignedFrontlineUnit.position.distanceTo(enemy.position) <= reserveLineChangeDistance);
        const formationId = reserveIds.has(unit.id) ? assignedFrontlineNearEnemy ? "line" : "column" : enemyWithinRange ? "line" : "column";

        if (unit.effectiveFormation === formationId) {
            continue;
        }

        formationChanges.push({ unitId: unit.id, formationId });
    }

    return formationChanges;
}

function initplayervalues(game, playerNumber) {
    const rotationtoenemy = playerNumber === 1 ? 3 * Math.PI / 2 : Math.PI / 2;
    const mapfarthesty = playerNumber === 1 ? 0 : game.map.height;

    return new Map([
        ["rotationtoenemy", rotationtoenemy],
        ["mapfarthesty", mapfarthesty]
    ]);
}

function infcommander(game, infantry, playerValues) {
    const orders = [];
    const ignoredCatchupIds = commandstate.get("ignoredCatchupIds") || new Set();
    infantry.filter(unit => unit.isRoutingOrRecovering()).forEach(unit => ignoredCatchupIds.add(unit.id));
    commandstate.set("ignoredCatchupIds", ignoredCatchupIds);
    const readyInfantry = infantry.filter(unit => !unit.isRoutingOrRecovering());
    if (readyInfantry.length === 0) {
        return [];
    }

    const { lineWidth, lineFormation } = getlineinfo(readyInfantry);
    const objectiveInfo = getobjectiveinfo(game);
    if (!objectiveInfo) {
        return [];
    }
    const { leftmostCenterObjective: lcentpos, rightmostCenterObjective: rcentpos } = objectiveInfo;
    const frontamt=getAmountThatFits(lcentpos, rcentpos, lineWidth);
    const rearamt=readyInfantry.length-frontamt;

    console.log(frontamt, rearamt,lineWidth,lineFormation, lcentpos, rcentpos,commandstate);
    

    if (!commandstate.has("phase")) {
        initializecommandstate(
            infantry,
            lcentpos,
            rcentpos,
            frontamt,
            lineWidth
        );
    }
    const oglineY=commandstate.get("oglineY");
    const stagingpositions=commandstate.get("stagingpositions");
    let phase = commandstate.get("phase");

    const roles = updateinfantryroles(
        readyInfantry,
        frontamt,
        frontlineReplacementDistance,
        phase
    );
    if (phase === "staging" && mostinfinposition(readyInfantry)) {
        commandstate.set("phase", "attack");
        phase = "attack";
    }
    const unitsById = new Map(readyInfantry.map(unit => [unit.id, unit]));
    roles.reserveAssignments.forEach((frontlineId, reserveId) => {
            orders.push({
                type: 1,
                id: reserveId,
                targetId: frontlineId
            });
        });
    // roles.reserveAssignments.forEach((frontlineId, reserveId) => {
    //     const frontPosition = unitsById.get(frontlineId).position;
    //     console.log(frontPosition);
    //     const reservePosition = getreserveposition(
    //         frontPosition,
    //         oglineY,
    //         lineWidth
    //     );
    //     orders.push({
    //         type: 4,
    //         id: reserveId,
    //         path: [[reservePosition.x, reservePosition.y]],
    //         rotation: playerValues.get("rotationtoenemy")
    //     });
    // });
    roles.withdrawalIds.forEach(unitId => {
        const unit = unitsById.get(unitId);
        const withdrawalPosition = getwithdrawalposition(unit, oglineY);
        orders.push({
            type: 6,
            id: unitId,
            path: [[withdrawalPosition.x, withdrawalPosition.y]],
            rotation: playerValues.get("rotationtoenemy")
        });
    });
    console.log(commandstate,roles)

    if (phase === "staging") {
        roles.frontlineIds.forEach((unitId, index) => {
            const position = stagingpositions[index];
            if (unitsById.has(unitId)) {
                orders.push({
                    type: 4,
                    id: unitId,
                    path: [[position.x, position.y]],
                    rotation: playerValues.get("rotationtoenemy")
                });
            }
        });
    } else if (phase === "attack") {
        const frontlineY = getfrontliney(
            readyInfantry.filter(unit => !ignoredCatchupIds.has(unit.id)),
            oglineY,
            playerValues.get("mapfarthesty"),
            infantryCatchupDistance
        );
        const positions = getequallyspacedtightpositions(
            lcentpos,
            rcentpos,
            lineWidth,
            roles.frontlineIds.length,
            frontlineY
        );

        const positionByFrontId = new Map(
            roles.frontlineIds.map((unitId, index) => [unitId, positions[index]])
        );

        roles.frontlineIds.forEach(unitId => {
            const position = positionByFrontId.get(unitId);
            orders.push({
                type: 4, // FAA
                id: unitId,
                path: [[position.x, position.y]],
                rotation: playerValues.get("rotationtoenemy")
            });
        });
    }


    // readyInfantry.slice(lineCount).forEach((unit, index) => {
    //     const linePosition = linePositions[index % linePositions.length];
    //     const reserveRow = Math.floor(index / linePositions.length) + 1;
    //     const reserveY = linePlacement.lineY + behindDirection * reserveDepth * reserveRow;
    //     orders.push({
    //         type: 4, // FAA
    //         id: unit.id,
    //         path: [[linePosition.x, reserveY]]
    //     });
    // });

    return orders;
}

function initializecommandstate(infantry, lcentpos, rcentpos, frontamt, spacing) {
    const oglineY = infantry.reduce((total, unit) => total + unit.position.y, 0) / infantry.length;
    const stagingY = (oglineY + lcentpos.y) / 2;
    const stagingpositions = getequallyspacedtightpositions(
        lcentpos,
        rcentpos,
        spacing,
        frontamt,
        stagingY
    );

    commandstate.set("oglineY", oglineY);
    commandstate.set("stagingpositions", stagingpositions);
    commandstate.set("phase", "staging");
}

// for threshold its the max distance u can be away from the staging position to count, for percent 1 is all, 0.5 is half, 0.25 is quarter, etc.
function mostinfinposition(infantry,threshold=5,percent=1) {
    const positions=commandstate.get("stagingpositions");
    const infantryToCheck = infantry.slice(0, positions.length);
    const inPositionCount = infantryToCheck.filter((unit, index) => {
        return unit.position.distanceTo(positions[index]) <= threshold;
    }).length;

    return inPositionCount / infantryToCheck.length >= percent;
}

function getfrontliney(infantry, oglineY, mapfarthesty, catchupDistance) {
    const yValues = infantry.length ? infantry.map(unit => unit.position.y) : [mapfarthesty];
    const furthestY = mapfarthesty < oglineY ? Math.min(...yValues) : Math.max(...yValues);
    const furthestBehindY = mapfarthesty < oglineY ? Math.max(...yValues) : Math.min(...yValues);
    const distanceBetweenInfantry = Math.abs(furthestBehindY - furthestY);

    return distanceBetweenInfantry > catchupDistance ? furthestY : mapfarthesty;
}

function updateinfantryroles(readyInfantry, frontamt, replacementDistance, phase) {
    const unitsById = new Map(readyInfantry.map(unit => [unit.id, unit]));
    let frontlineIds = commandstate.get("frontlineIds");
    const reserveAssignments = commandstate.get("reserveAssignments") || new Map();
    const reserveIds = commandstate.get("reserveIds") || new Set();
    const withdrawalAssignments = commandstate.get("withdrawalAssignments") || new Map();
    const swappedLastTurnIds = commandstate.get("swappedLastTurnIds") || new Set();
    const swappedThisTurnIds = new Set();

    if (!frontlineIds && phase === "staging") {
        frontlineIds = readyInfantry.slice(0, frontamt).map(unit => unit.id);
        const reserveInfantry = readyInfantry.filter(unit => !frontlineIds.includes(unit.id));
        assignreserveinfantry(
            reserveInfantry,
            frontlineIds.map(unitId => unitsById.get(unitId))
        ).forEach((frontlineId, reserveId) => reserveAssignments.set(reserveId, frontlineId));
        reserveInfantry.forEach(unit => reserveIds.add(unit.id));
    }

    withdrawalAssignments.forEach((frontlineId, withdrawingId) => {
        withdrawalAssignments.delete(withdrawingId);
        reserveAssignments.set(withdrawingId, frontlineId);
        reserveIds.add(withdrawingId);
    });

    frontlineIds = frontlineIds.map((frontlineId, frontlineIndex) => {
        const frontlineUnit = unitsById.get(frontlineId);
        let reserveId;

        if (frontlineUnit) {
            for (const [reserveUnitId, assignedFrontlineId] of reserveAssignments) {
                const reserveUnit = unitsById.get(reserveUnitId);
                const assignedFrontlineIndex = frontlineIds.indexOf(assignedFrontlineId);
                const reserveCanCoverFrontline = assignedFrontlineIndex === frontlineIndex || reserveUnit && reserveUnit.effectiveFormation === "column" && Math.abs(assignedFrontlineIndex - frontlineIndex) === 1;
                const reserveCanReplace = reserveUnit &&
                    reserveCanCoverFrontline &&
                    !swappedLastTurnIds.has(frontlineId) &&
                    !swappedLastTurnIds.has(reserveUnitId) &&
                    reserveUnit.position.distanceTo(frontlineUnit.position) <= replacementDistance;

                if (reserveCanReplace) {
                    reserveId = reserveUnitId;
                    break;
                }
            }
        }

        if (frontlineUnit && reserveId && frontlineUnit.org < frontlineUnit.maxOrg * orgtoreplace) {
            reserveAssignments.delete(reserveId);
            reserveIds.delete(reserveId);
            withdrawalAssignments.set(frontlineId, reserveId);
            swappedThisTurnIds.add(frontlineId);
            swappedThisTurnIds.add(reserveId);
            return reserveId;
        }

        return frontlineId;
    });

    const withdrawalIds = new Set(withdrawalAssignments.keys());

    commandstate.set("frontlineIds", frontlineIds);
    commandstate.set("reserveIds", reserveIds);
    commandstate.set("reserveAssignments", reserveAssignments);
    commandstate.set("withdrawalIds", withdrawalIds);
    commandstate.set("withdrawalAssignments", withdrawalAssignments);
    commandstate.set("swappedLastTurnIds", swappedThisTurnIds);

    return {
        frontlineIds,
        reserveAssignments,
        withdrawalIds
    };
}

function assignreserveinfantry(reserveInfantry, frontlineInfantry) {
    const assignments = new Map();
    const assignmentCount = Math.min(reserveInfantry.length, frontlineInfantry.length);
    const candidateIndexes = Array.from({ length: frontlineInfantry.length }, (_, index) => index);
    const frontlineIndexes = [];

    for (let index = 0; index < assignmentCount; index += 1) {
        const preferredIndex = Math.round((index + 1) * frontlineInfantry.length / (assignmentCount + 1));
        const closestCandidateIndex = candidateIndexes.reduce((closestIndex, candidateIndex, currentIndex) => {
            return Math.abs(candidateIndex - preferredIndex) < Math.abs(candidateIndexes[closestIndex] - preferredIndex) ? currentIndex : closestIndex;
        }, 0);

        frontlineIndexes.push(candidateIndexes.splice(closestCandidateIndex, 1)[0]);
    }

    frontlineIndexes.sort((a, b) => a - b);
    const unassignedReserveInfantry = reserveInfantry.slice();

    frontlineIndexes.forEach(frontlineIndex => {
        const frontlineUnit = frontlineInfantry[frontlineIndex];
        let closestReserveIndex = 0;
        let closestDistance = unassignedReserveInfantry[0].position.distanceTo(frontlineUnit.position);

        unassignedReserveInfantry.forEach((reserveUnit, reserveIndex) => {
            const distance = reserveUnit.position.distanceTo(frontlineUnit.position);
            if (distance < closestDistance) {
                closestReserveIndex = reserveIndex;
                closestDistance = distance;
            }
        });

        const [closestReserve] = unassignedReserveInfantry.splice(closestReserveIndex, 1);
        assignments.set(closestReserve.id, frontlineUnit.id);
    });

    return assignments;
}

// function getreserveposition(frontPosition, oglineY, lineWidth) {
//     const behindDirection = oglineY >= frontPosition.y ? 1 : -1;
//     return {
//         x: frontPosition.x,
//         y: frontPosition.y + behindDirection * lineWidth * 2
//     };
// }

function getwithdrawalposition(unit, oglineY) {
    return {
        x: unit.position.x,
        y: oglineY
    };
}

function getlineinfo(readyInfantry) {
    const lineFormation = readyInfantry[0].gameDataManager.getUnitDimensions(
        readyInfantry[0].type,
        "line"
    );
    const lineWidth = lineFormation.height;
    return { lineWidth, lineFormation };
}

function getobjectiveinfo(game) {
    const objectives = game.getObjectives();
    if (objectives.length < 2) {
        console.log("NO OBJECTIVES???")
        return null;
    }

    // The largest objective row is the center line, with proximity to the map center breaking ties.
    const mapCenterY = game.map.height / 2;
    const objectiveRows = [];

    objectives.slice().sort((a, b) => a.position.y - b.position.y).forEach(objective => {
        const matchingRow = objectiveRows.find(row => Math.abs(row.averageY - objective.position.y) <= centerObjectiveRowTolerance);
        if (matchingRow) {
            matchingRow.objectives.push(objective);
            matchingRow.averageY = matchingRow.objectives.reduce((total, rowObjective) => total + rowObjective.position.y, 0) / matchingRow.objectives.length;
        } else {
            objectiveRows.push({ objectives: [objective], averageY: objective.position.y });
        }
    });

    const reasonableCenterRows = objectiveRows.filter(row => row.objectives.length >= 2 && Math.abs(row.averageY - mapCenterY) <= game.map.height * centerObjectiveMaxDistanceRatio);
    if (reasonableCenterRows.length === 0) {
        console.log("Waiting for center stars");
        return null;
    }

    reasonableCenterRows.sort((a, b) => b.objectives.length - a.objectives.length || Math.abs(a.averageY - mapCenterY) - Math.abs(b.averageY - mapCenterY));
    const centerObjectives = reasonableCenterRows[0].objectives.sort((a, b) => a.position.x - b.position.x);
    const centerObjectiveCount = centerObjectives.length;
    console.log("Computed center star count:", centerObjectiveCount);

    return {
        leftmostCenterObjective: centerObjectives[0].position,
        rightmostCenterObjective: centerObjectives[centerObjectives.length - 1].position
    };
}

function getAmountThatFits(startPosition, endPosition, width) {
    const distanceX = endPosition.x - startPosition.x;
    const distanceY = endPosition.y - startPosition.y;
    const distance = Math.hypot(distanceX, distanceY);

    return Math.floor(distance / width);
}

function getEquallySpacedPositions(startPosition, endPosition, amount, y) {
    if (amount <= 0) {
        return [];
    }

    if (amount === 1) {
        return [{
            x: (startPosition.x + endPosition.x) / 2,
            y: y ?? (startPosition.y + endPosition.y) / 2
        }];
    }

    const positions = [];
    const intervals = amount - 1;
    const xStep = (endPosition.x - startPosition.x) / intervals;
    const yStep = (endPosition.y - startPosition.y) / intervals;

    for (let index = 0; index < amount; index += 1) {
        positions.push({
            x: startPosition.x + xStep * index,
            y: y ?? startPosition.y + yStep * index
        });
    }

    return positions;
}

function getequallyspacedtightpositions(startPosition, endPosition, spacing, amount, y) {
    if (amount <= 0) {
        return [];
    }

    const centerX = (startPosition.x + endPosition.x) / 2;
    const firstX = centerX - spacing * (amount - 1) / 2;
    const positions = [];

    for (let index = 0; index < amount; index += 1) {
        positions.push({
            x: firstX + spacing * index,
            y
        });
    }

    return positions;
}
