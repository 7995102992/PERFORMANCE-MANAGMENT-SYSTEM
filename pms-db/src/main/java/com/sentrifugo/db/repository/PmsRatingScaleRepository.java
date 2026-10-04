package com.sentrifugo.db.repository;

import com.sentrifugo.db.entity.PmsRatingScaleEntity;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Optional;
import java.util.UUID;

public interface PmsRatingScaleRepository extends JpaRepository<PmsRatingScaleEntity, UUID> {

    /** Organisation-scoped lookup: the way to load a row without crossing tenants. */
    Optional<PmsRatingScaleEntity> findByIdAndOrganisationId(UUID id, UUID organisationId);
}
