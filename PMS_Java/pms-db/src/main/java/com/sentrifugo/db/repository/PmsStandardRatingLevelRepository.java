package com.sentrifugo.db.repository;

import com.sentrifugo.db.entity.PmsStandardRatingLevelEntity;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface PmsStandardRatingLevelRepository extends JpaRepository<PmsStandardRatingLevelEntity, UUID> {

    /** Organisation-scoped lookup: the way to load a row without crossing tenants. */
    Optional<PmsStandardRatingLevelEntity> findByIdAndOrganisationId(UUID id, String organisationId);

    List<PmsStandardRatingLevelEntity> findByOrganisationIdAndIsActiveTrueOrderByCreatedDateAsc(String organisationId);

    boolean existsByOrganisationIdAndLabelIgnoreCaseAndIsActiveTrue(String organisationId, String label);

    boolean existsByOrganisationIdAndLabelIgnoreCaseAndIsActiveTrueAndIdNot(String organisationId, String label,
                                                                            UUID id);
}
