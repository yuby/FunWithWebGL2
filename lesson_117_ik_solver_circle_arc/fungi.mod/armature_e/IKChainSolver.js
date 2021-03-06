import Maths, { Vec3, Quat }	from "../../fungi/Maths.js";
import TNode 					from "../../fungi/components/TransformNode.js";
import { QUAT_FWD2UP }			from "./IKChain.js";


//###################################################################
// Just helps calculate transform data.
//###################################################################

class TransformData{
	constructor(){
		this.rotation	= new Quat();
		this.position	= new Vec3();
		this.scale 		= new Vec3(1,1,1);
	}

	set(r=null, p=null, s=null){
		if( r )	this.rotation.copy( r );
		if( p )	this.position.copy( p );
		if( s )	this.scale.copy( s );
		return this;
	}

	add(cr, cp, cs){
		//POSITION - parent.position + ( parent.rotation * ( parent.scale * child.position ) )
		let v = new Vec3();
		Vec3.mul( this.scale, cp, v ); // parent.scale * child.position;
		this.position.add( Vec3.transformQuat( v, this.rotation, v ) );

		// SCALE - parent.scale * child.scale
		this.scale.mul( cs );

		// ROTATION - parent.rotation * child.rotation
		this.rotation.mul( cr );

		return this;
	}
}


//###################################################################
// Universal Data used by the solvers to align bones
//###################################################################

class IKTarget{
	constructor(){
		this.rotation = new Quat();	// Rotation toward the forward axis(z)
		this.position = new Vec3();	// Optional, World Position of the target.

		this.scale	= null;			// Optional, Scale chain length with this when available.
		this.x		= new Vec3();	// Target XYZ Rotation Axis
		this.y		= new Vec3();
		this.z		= new Vec3();
	}


	//////////////////////////////////////////////////////////////
	//
	//////////////////////////////////////////////////////////////
	setEndPoints(p0, p1, vUp=null){
		this.position.copy( p1 );
		this.scale = null;
		Vec3.sub(p1, p0, this.z); // Forward

		//this.targetLength = Vec3.sub(p1, p0, this.z).length();		

		if(!vUp){ //Make sure Forward and UP isn't the same direction.
			var v = Vec3.nearZero( this.z );

			if(v.x == 0 && v.z == 0){	//Depending on Direction, UP is Back, Down is Forward
				vUp = (v.y >= 0)? Vec3.BACK : Vec3.FORWARD;
			}else vUp = Vec3.UP;
		}

		Vec3.cross(vUp, this.z.normalize(), this.x).normalize();	// Left
		Vec3.cross(this.z, this.x, this.y).normalize();				// Up
		Quat.fromAxis(this.x, this.y, this.z, this.rotation);		// Rotation to point forward (Z)

		return this;
	}

	setRotationScale(q, s){
		this.position.set(0, 0, 0);

		this.scale = s;

		Vec3.transformQuat(Vec3.UP,		q, this.z);			// Because of up bones, forward is up,
		Vec3.transformQuat(Vec3.BACK,	q, this.y);			// Which makes UP backward
		Vec3.transformQuat(Vec3.LEFT,	q, this.x);			// Keft stays the same

		Quat.fromAxis(this.x, this.y, this.z, this.rotation);	// Rotation to point forward (Z)
		return this;
	}


	//////////////////////////////////////////////////////////////
	//
	//////////////////////////////////////////////////////////////
	static debug(DVao, eLine, ePoint, t, offset = null){
		offset = offset || Vec3.ZERO;

		//var zlen = Vec3.scale(t.z, t.scale).add(offset);
		var zlen = new Vec3(t.z);
		if(t.scale) zlen.scale( t.scale );
		zlen.add( offset );

		DVao.vecLine(eLine, offset, Vec3.scale(t.x, 0.3).add(offset), 0);
		DVao.vecLine(eLine, offset, Vec3.scale(t.y, 0.3).add(offset), 2);
		DVao.vecLine(eLine, offset, zlen, 1);


		DVao.vecPoint(ePoint, (t.scale)? zlen : t.position, 0);

		DVao.vecPoint(ePoint, offset, 8);
	}

}


//###################################################################
// Main Solver Functions
//###################################################################

class IKChainSolver{

	//////////////////////////////////////////////////////////////
	// Single Pass Solvers
	//////////////////////////////////////////////////////////////
	static twoBone(chain, target, pose){
		//------------------------------------
		// If over the length of the chain, straighten chain.		
		if(target.scale > 0.9999){
			IKChainSolver.fullDirection(chain, target, pose);
			return;
		}

		//.......................................
		// Law of Cosines - SSS
		// cos(C) = (a^2 + b^2 - c^2) / 2ab
		// Calculate the angle between the two bones.
		let aLen	= chain.links[0].com.Bone.length,
			bLen	= chain.links[1].com.Bone.length,
			cLen	= chain.length * target.scale,
			cAngle 	= Math.PI - Math.acos( (aLen*aLen + bLen*bLen - cLen*cLen) / (2 * aLen * bLen) );

		//.......................................
		pose.links[0].rotation.copy( target.rotation );	// set the forward rotation of the bone toward the target.
		pose.links[0].useRotation = true;
		pose.links[1].rotation.setAxisAngle( target.x, cAngle );
		pose.links[1].useRotation = true;

		//------------------------------------
		//Align the bones to the target axis
		let chainPosition	= TNode.getWorldPosition( chain.links[0] ),						// world position start of chain
			endPosition		= IKChainSolver.chainEndPosition( chain, pose, chainPosition );	// world position of end of chain
		IKChainSolver.alignFwdRotation(chain, target, pose, endPosition.sub(chainPosition).normalize() );
	}


	static circleArc(chain, target, pose){
		const BX1 = 0.42;	// Predefined Bezier curve control points
		const BY1 = 0.175;	// .. Point 0 and Point 3 is 0,0 and 1,0
		const BX2 = 0.98;
		const BY2 = 2.208;

		//------------------------------------
		// If over the length of the chain, straighten chain.		
		if(target.scale > 0.9999){
			IKChainSolver.fullDirection(chain, target, pose);
			return;
		}

		//------------------------------------
		// Figure out what angle the arc of a circle, then based on its normalized value
		// use a predefined bezier curve to get the proper offset on the angle which
		// helps align the arc to the target position.

		let chainPosition 	= TNode.getWorldPosition( chain.links[0] ),
			scale			= target.scale;

		if(!scale){
			scale = chainPosition.length( target.position ) / chain.length;

			//Check scale, if over length of chain, then straighten it out.
			if(scale > 0.9999){
				IKChainSolver.fullDirection(chain, target, pose);
				return;
			}
		}

		let arcAngle = Maths.PI_2 * -(1 - scale);
		arcAngle -= Maths.CBezierEase( scale, 0,0, BX1, BY1, BX2, BY2, 1,0 );

		
		//------------------------------------
		// Get starting world transform for joint chain and keep track as we traverse.
		let cnt 		= Math.min(pose.count, chain.count),
			angleInc	= -arcAngle / cnt, //Divide angle per bone for rotation increment;
			qInc 		= new Quat().setAxisAngle(target.x, angleInc);


		pose.links[0].rotation.copy( target.rotation );	// Start off By Setting the forward rotation of the bone toward the target.
		pose.links[0].rotation.pmul( qInc );			// Then apply the first increment on it using target's X Axis Rotation
		pose.links[0].useRotation = true;

		qInc.setAxisAngle(Vec3.LEFT, angleInc); 		// With the root facing in the right direction, reset Inc with world X Axis
		for(let i = 1; i < cnt; i++){
			// Save rotation to the ik state to apply to bones later.
			pose.links[i].rotation.copy( qInc );
			pose.links[i].useRotation = true;
		}


		//------------------------------------
		//The end position usually doesn't line up with the target, so try to align it
		let endPosition = IKChainSolver.chainEndPosition( chain, pose, chainPosition );	// world position of end of chain

		IKChainSolver.alignFwdRotation(chain, target, pose, endPosition.sub(chainPosition).normalize());
	}



	//////////////////////////////////////////////////////////////
	// Helper Functions
	//////////////////////////////////////////////////////////////

	// Aligns the first bone to the target axis, then resets rotation/position of all sub links from the root.
	static fullDirection(chain, target, pose, resetPosition=false){
		// Point chain at the target direction
		IKChainSolver.aimDirection(chain, target, pose, true);

		//Reset Rotation ( and Position ) on all bones except the first one.
		let i,c;
		for(i=1; i < chain.count; i++){
			c = chain.links[i].com;

			pose.links[ i ].rotation.copy( c.Bone.initRotation );
			pose.links[ i ].useRotation	= true;

			if(resetPosition){
				pose.links[ i ].position.copy( c.Bone.initPosition );
				pose.links[ i ].usePosition	= true;
			}
		}
	}

	// Aligns the first link of the chain toward the target axis
	static aimDirection(chain, target, pose, doOffset=false){
		pose.links[0].useRotation = true;
		pose.links[0].rotation.copy( target.rotation );

		if(doOffset) pose.links[0].rotation.mul( QUAT_FWD2UP );
	}

	// Using a unit direction, try to align the chain to the z axis of the target.
	static alignFwdRotation(chain, target, pose, fromDir){
		let vUp		= ( Vec3.dot(target.z, fromDir) >= 0 )? target.y : target.z,	// Depending on angle, different up is needed.
			qTarget	= Quat.invert( target.rotation ),	// Inverted target direction rotation
			qEnd	= new Quat();						// Rotation toward End Point

		Quat.lookRotation( fromDir, vUp, qEnd );		// Create rotation based on the direction of the end point

		qEnd.mul( qTarget ).invert();					// Get Difference between the 2 rotations, then invert it
		pose.links[0].rotation.pmul( qEnd );			// Rotate first bone to line up with target.
		pose.links[0].useRotation = true;
	}

	//Find the End Position of a chain pose
	static chainEndPosition( chain, pose, chainPosition, out = null ){
		// Need to keep track of WorldSpace rotation/position for final bone
		// Start the transform data with the first bone information.
		let tran 	= new TransformData(),
			c 		= chain.links[ 0 ].com,
			cnt		= Math.min( chain.count, pose.count );

		tran.set( pose.links[0].rotation, chainPosition, c.Transform.scale ); //Set info of the first bone.

		// Keep Track of World Space Rotation/Position.
		for(let i=1; i < cnt; i++){
			c = chain.links[ i ].com;
			tran.add( pose.links[i].rotation, c.Transform.position, c.Transform.scale );
		}

		// Finish with last bone length to get the World Space Position of the end of the last bone.
		tran.add( pose.links[cnt-1].rotation, [0,c.Bone.length,0], c.Transform.scale);

		return (out || new Vec3()).copy( tran.position );
	}
}

//###################################################################
// Main Solver Functions
//###################################################################

export default IKChainSolver;
export { IKTarget, TransformData };