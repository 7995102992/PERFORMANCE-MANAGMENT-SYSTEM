package com.sentrifugo.common.exception;

/** The error body shape every PMS endpoint returns, per the API contract. */
public record ApiError(String detail, String code) {
}
