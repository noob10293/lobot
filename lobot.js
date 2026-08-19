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



    turnSubmission.formationChanges.push(...infantryFormationChanges(myinf, visibleEnemyUnits));
    const playerTwoRotation = Math.PI / 2;
    const finalRotation = playerNumber === 1 ? 3 * Math.PI / 2 : playerTwoRotation;
    turnSubmission.orders.push(...infcommander(game, myinf, finalRotation));



    return turnSubmission;
}

function infantryFormationChanges(infantry, visibleEnemyUnits) {
    const formationChanges = [];
    const readyInfantry = infantry.filter(unit => !unit.isRoutingOrRecovering());

    for (const unit of readyInfantry) {
        const multi=3;
        const enemyWithinRange = visibleEnemyUnits.some(enemy => {
            const distanceToEnemy = unit.position.distanceTo(enemy.position);
            return distanceToEnemy <= unit.getMaxRange() * multi;
        });
        const formationId = enemyWithinRange ? "line" : "column";

        if (unit.effectiveFormation === formationId) {
            continue;
        }

        formationChanges.push({ unitId: unit.id, formationId });
    }

    return formationChanges;
}

function infcommander(game, infantry, finalRotation) {
    const orders = [];
    const readyInfantry = infantry.filter(unit => !unit.isRoutingOrRecovering());
    if (readyInfantry.length === 0) {
        return [];
    }

    const { lineWidth, lineFormation } = getlineinfo(readyInfantry);
    const { leftmostCenterObjective: lcentpos, rightmostCenterObjective: rcentpos } = getobjectiveinfo(game);
    const frontamt=getAmountThatFits(lcentpos, rcentpos, lineWidth);
    const rearamt=readyInfantry.length-frontamt;

    console.log(frontamt, rearamt,lineWidth,lineFormation, lcentpos, rcentpos)


    const positions = getEquallySpacedPositions(lcentpos, rcentpos, frontamt);

    readyInfantry.slice(0, frontamt).forEach((unit, index) => {
        const position = positions[index];
        orders.push({
            type: 4, // FAA
            id: unit.id,
            path: [[position.x, position.y]],
            rotation: finalRotation
        });
    });

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

// function calculateLinePositions(linePlacement, lineWidth, infantryCount) {
//     const startPosition = {
//         x: linePlacement.lineStartX,
//         y: linePlacement.lineY
//     };
//     const endPosition = {
//         x: linePlacement.lineStartX + linePlacement.lineLength,
//         y: linePlacement.lineY
//     };
//     const maximumLineCount = getAmountThatFits(startPosition, endPosition, lineWidth);
//     const lineCount = Math.min(infantryCount, maximumLineCount);
//     const linePositions = getEquallySpacedPositions(startPosition, endPosition, lineCount);

//     return { linePositions, lineCount };
// }

function getAmountThatFits(startPosition, endPosition, width) {
    const distanceX = endPosition.x - startPosition.x;
    const distanceY = endPosition.y - startPosition.y;
    const distance = Math.hypot(distanceX, distanceY);

    return Math.floor(distance / width);
}

function getEquallySpacedPositions(startPosition, endPosition, amount) {
    if (amount <= 0) {
        return [];
    }

    if (amount === 1) {
        return [{
            x: (startPosition.x + endPosition.x) / 2,
            y: (startPosition.y + endPosition.y) / 2
        }];
    }

    const positions = [];
    const intervals = amount - 1;
    const xStep = (endPosition.x - startPosition.x) / intervals;
    const yStep = (endPosition.y - startPosition.y) / intervals;

    for (let index = 0; index < amount; index += 1) {
        positions.push({
            x: startPosition.x + xStep * index,
            y: startPosition.y + yStep * index
        });
    }

    return positions;
}
