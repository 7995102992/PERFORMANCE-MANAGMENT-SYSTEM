from bson import ObjectId


def to_oid(value):
    """Coerce a value to ObjectId.

    Accepts ObjectId (returned unchanged) or a 24-hex-char string.
    Returns None for falsy input.
    """
    if not value:
        return None
    if isinstance(value, ObjectId):
        return value
    return ObjectId(value)


def uid_match(value):
    """Build a Mongo match clause that catches a user_id stored as either an
    ObjectId or its 24-hex-char string form.

    The canonical storage form is ObjectId, but some legacy rows may have been
    written as strings via past code paths. Use this when reading/updating
    rows by user_id from collections that may have mixed shapes.
    """
    oid = to_oid(value)
    if oid is None:
        return value
    return {"$in": [oid, str(oid)]}
