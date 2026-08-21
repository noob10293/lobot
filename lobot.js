const commandstate = new Map();
const frontlineReplacementDistance = 100;
const infantryCatchupDistance = 100;
const orgtoreplace=0.6

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
    turnSubmission.formationChanges.push(...infantryFormationChanges(
        myinf,
        visibleEnemyUnits,
        commandstate.get("reserveIds")
    ));



    return turnSubmission;
}

function infantryFormationChanges(infantry, visibleEnemyUnits, reserveIds = new Set()) {
    const formationChanges = [];
    const readyInfantry = infantry.filter(unit => !unit.isRoutingOrRecovering());

    for (const unit of readyInfantry) {
        const multi=3;
        const enemyWithinRange = visibleEnemyUnits.some(enemy => {
            const distanceToEnemy = unit.position.distanceTo(enemy.position);
            return distanceToEnemy <= unit.getMaxRange() * multi;
        });
        const formationId = reserveIds.has(unit.id) || !enemyWithinRange ? "column" : "line";

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
    const readyInfantry = infantry.filter(unit => !unit.isRoutingOrRecovering());
    if (readyInfantry.length === 0) {
        return [];
    }

    const { lineWidth, lineFormation } = getlineinfo(readyInfantry);
    const { leftmostCenterObjective: lcentpos, rightmostCenterObjective: rcentpos } = getobjectiveinfo(game);
    const frontamt=getAmountThatFits(lcentpos, rcentpos, lineWidth);
    const rearamt=readyInfantry.length-frontamt;

    console.log(frontamt, rearamt,lineWidth,lineFormation, lcentpos, rcentpos,commandstate);
    

    if (commandstate.size === 0) {
        initializecommandstate(
            infantry,
            lcentpos,
            rcentpos,
            frontamt,
            lineWidth
        );
    }
    if (mostinfinposition(readyInfantry)) {
        commandstate.set("phase", "attack");
    }

    const oglineY=commandstate.get("oglineY");
    const stagingpositions=commandstate.get("stagingpositions");
    const phase = commandstate.get("phase");

        const roles = updateinfantryroles(
            readyInfantry,
            frontamt,
            frontlineReplacementDistance
        );
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
        readyInfantry.slice(0, frontamt).forEach((unit, index) => {
            const position = stagingpositions[index];
            orders.push({
                type: 4,
                id: unit.id,
                path: [[position.x, position.y]],
                rotation: playerValues.get("rotationtoenemy")
            });
        });
    } else if (phase === "attack") {
        const frontlineY = getfrontliney(
            readyInfantry,
            oglineY,
            playerValues.get("mapfarthesty"),
            infantryCatchupDistance
        );
        const positions = getequallyspacedtightpositions(
            lcentpos,
            rcentpos,
            lineWidth,
            frontamt,
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
function mostinfinposition(infantry,threshold=2,percent=1) {
    const positions=commandstate.get("stagingpositions");
    const infantryToCheck = infantry.slice(0, positions.length);
    const inPositionCount = infantryToCheck.filter((unit, index) => {
        return unit.position.distanceTo(positions[index]) <= threshold;
    }).length;

    return inPositionCount / infantryToCheck.length >= percent;
}

function getfrontliney(infantry, oglineY, mapfarthesty, catchupDistance) {
    const yValues = infantry.map(unit => unit.position.y);
    const furthestY = mapfarthesty < oglineY ? Math.min(...yValues) : Math.max(...yValues);
    const furthestBehindY = mapfarthesty < oglineY ? Math.max(...yValues) : Math.min(...yValues);
    const distanceBetweenInfantry = Math.abs(furthestBehindY - furthestY);

    return distanceBetweenInfantry > catchupDistance ? furthestY : mapfarthesty;
}

function updateinfantryroles(readyInfantry, frontamt, replacementDistance) {
    const unitsById = new Map(readyInfantry.map(unit => [unit.id, unit]));
    let frontlineIds = commandstate.get("frontlineIds");
    let reserveAssignments = commandstate.get("reserveAssignments");
    const withdrawalIds = new Set();

    if (!frontlineIds) {
        frontlineIds = readyInfantry.slice(0, frontamt).map(unit => unit.id);
        reserveAssignments = assignreserveinfantry(
            readyInfantry.filter(unit => !frontlineIds.includes(unit.id)),
            frontlineIds
        );
    }
    reserveAssignments = reserveAssignments || new Map();

    const promotedReserveIds = new Set();
    frontlineIds = frontlineIds.map(frontlineId => {
        const frontlineUnit = unitsById.get(frontlineId);
        let reserveId;

        if (frontlineUnit) {
            for (const reserveUnitId of reserveAssignments.keys()) {
                const reserveUnit = unitsById.get(reserveUnitId);
                const reserveCanReplace = reserveUnit &&
                    !promotedReserveIds.has(reserveUnitId) &&
                    reserveUnit.position.distanceTo(frontlineUnit.position) <= replacementDistance;

                if (reserveCanReplace) {
                    reserveId = reserveUnitId;
                    break;
                }
            }
        }

        if (frontlineUnit && reserveId && frontlineUnit.org < frontlineUnit.maxOrg * orgtoreplace) {
            promotedReserveIds.add(reserveId);
            withdrawalIds.add(frontlineId);
            return reserveId;
        }

        return frontlineId;
    });

    const reserveIds = readyInfantry
        .filter(unit => !frontlineIds.includes(unit.id) && !withdrawalIds.has(unit.id))
        .map(unit => unit.id);
    reserveAssignments = assignreserveinfantry(
        reserveIds.map(unitId => unitsById.get(unitId)),
        frontlineIds
    );

    commandstate.set("frontlineIds", frontlineIds);
    commandstate.set("reserveIds", new Set(reserveIds));
    commandstate.set("reserveAssignments", reserveAssignments);
    commandstate.set("withdrawalIds", withdrawalIds);

    return {
        frontlineIds,
        reserveAssignments,
        withdrawalIds
    };
}

function assignreserveinfantry(reserveInfantry, frontlineIds) {
    const assignments = new Map();
    const reserveCount = reserveInfantry.length;
    const frontlineCount = frontlineIds.length;
    const usedFrontlineIndexes = new Set();
    const firstInteriorIndex = frontlineCount > 2 ? 1 : 0;
    const lastInteriorIndex = frontlineCount > 2 ? frontlineCount - 2 : frontlineCount - 1;
    const candidateIndexes = [];

    for (let index = firstInteriorIndex; index <= lastInteriorIndex; index += 1) {
        candidateIndexes.push(index);
    }

    for (let index = 0; index < frontlineCount; index += 1) {
        if (!candidateIndexes.includes(index)) {
            candidateIndexes.push(index);
        }
    }

    reserveInfantry.forEach((unit, index) => {
        const preferredIndex = Math.round(
            (index + 1) * frontlineCount / (reserveCount + 1)
        );
        let followedIndex;
        let closestDistance;

        candidateIndexes.forEach(candidateIndex => {
            if (usedFrontlineIndexes.has(candidateIndex)) {
                return;
            }

            const distance = Math.abs(candidateIndex - preferredIndex);
            if (closestDistance === undefined || distance < closestDistance) {
                followedIndex = candidateIndex;
                closestDistance = distance;
            }
        });

        if (followedIndex !== undefined) {
            usedFrontlineIndexes.add(followedIndex);
            assignments.set(unit.id, frontlineIds[followedIndex]);
        }
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
    if (objectives.length < 3) {
        console.log("NO OBJECTIVES???")
        return null;
    }

    // The three objectives closest to the map's horizontal center are the center line.
    const mapCenterY = game.map.height / 2;
    const centerObjectives = objectives
        .slice()
        .sort((a, b) => {
            const aCenterDistance = Math.abs(a.position.y - mapCenterY);
            const bCenterDistance = Math.abs(b.position.y - mapCenterY);
            return aCenterDistance - bCenterDistance;
        })
        .slice(0, 3)
        .sort((a, b) => a.position.x - b.position.x);

    return {
        leftmostCenterObjective: centerObjectives[0].position,
        rightmostCenterObjective: centerObjectives[2].position
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
