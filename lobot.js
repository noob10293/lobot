function onBotPlay(game, playerNumber) {
  const allUnits = game.getUnits();
  const turnSubmission = {
    orders: [],
    autofireConfigChanges: []
  };
  
  // console.log("Unit categories:", allUnits.map(unit => ({
  //   id: unit.id,
  //   player: unit.player,
  //   category: unit.category
  // })));
  console.log(game)

  const myUnits = allUnits.filter(unit => unit.player === playerNumber);
  const enemyUnits = allUnits.filter(unit => unit.team !== game.getPlayerTeam(playerNumber));

  // Group units by their battlefield category.
  const mycav = myUnits.filter(unit => [
    "scoutCavalry",
    "lightCavalry",
    "midCavalry",
    "heavyCavalry"
  ].includes(unit.category));
  const myarty = myUnits.filter(unit => unit.category === "artillery");
  const myinf = myUnits.filter(unit => [
    "infantry",
    "guardsInfantry",
    "militiaInfantry"
  ].includes(unit.category));
  const myskirms = myUnits.filter(unit => unit.category === "skirmishInfantry");

  // Assign each artillery piece the closest unassigned infantry on the x axis.
  const assignedInfantry = new Set();
  for (const arty of myarty) {
    let closestInf = null;
    let closestXDistance = Infinity;

    for (const inf of myinf) {
      if (assignedInfantry.has(inf.id) || inf.isRoutingOrRecovering()) {
        continue;
      }

      const xDistance = Math.abs(inf.position.x - arty.position.x);
      if ( xDistance < closestXDistance) {
        closestInf = inf;
        closestXDistance = xDistance;
      }
    }

    if (closestInf) {
      assignedInfantry.add(closestInf.id);
      turnSubmission.orders.push({
        type: 4, // FireAndAdvance
        id: closestInf.id,
        path: [[arty.position.x, arty.position.y]]
      });
    }
  }

  // const ogfunc=game.movementSystem.process
  // game.movementSystem.process= function(...args){
  //   console.log(args);
  //   const result = ogfunc.apply(this, args);
  //   console.log(result)

  //   return result
  // }
  // for (const unit of myUnits) {
  //   if (unit.isRoutingOrRecovering()) {
  //     continue;
  //   }
    
    // Find closest enemy
    // const closestEnemy = game.getClosestUnitOf(unit.position, enemyUnits);
    
    // if (closestEnemy) {
    //   const distance = unit.position.distanceTo(closestEnemy.position);
      
    //   if (distance <= unit.getMaxRange()) {
    //     // In range - charge if we have advantage
    //     if (unit.org > closestEnemy.org && (unit.org - closestEnemy.org) > 150) {
    //       turnSubmission.orders.push({
    //         type: 2, // Run
    //         id: unit.id,
    //         targetId: closestEnemy.id
    //       });
    //     } else {
    //       // Fire and advance
    //       turnSubmission.orders.push({
    //         type: 4, // FireAndAdvance
    //         id: unit.id,
    //         path: [[closestEnemy.position.x, closestEnemy.position.y]]
    //       });
    //     }
    //   } else {
    //     // Move closer
    //     turnSubmission.orders.push({
    //       type: 1, // Walk
    //       id: unit.id,
    //       path: [[closestEnemy.position.x, closestEnemy.position.y]]
    //     });
    //   }
    // }
  // }
  
  return turnSubmission;
}
